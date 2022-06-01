/*
Copyright 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {verifyEd25519Signature, SIGNATURE_ALGORITHM} from "./common.js";

const TRACKING_STATUS_OUTDATED = 0;
const TRACKING_STATUS_UPTODATE = 1;

export function addRoomToIdentity(identity, userId, roomId) {
    if (!identity) {
        identity = {
            userId: userId,
            roomIds: [roomId],
            deviceTrackingStatus: TRACKING_STATUS_OUTDATED,
        };
        return identity;
    } else {
        if (!identity.roomIds.includes(roomId)) {
            identity.roomIds.push(roomId);
            return identity;
        }
    }
}

// map 1 device from /keys/query response to DeviceIdentity
function deviceKeysAsDeviceIdentity(deviceSection) {
    const deviceId = deviceSection["device_id"];
    const userId = deviceSection["user_id"];
    return {
        userId,
        deviceId,
        ed25519Key: deviceSection.keys[`ed25519:${deviceId}`],
        curve25519Key: deviceSection.keys[`curve25519:${deviceId}`],
        algorithms: deviceSection.algorithms,
        displayName: deviceSection.unsigned?.device_display_name,
    };
}

export class DeviceTracker {
    constructor({storage, getSyncToken, olmUtil, ownUserId, ownDeviceId}) {
        this._storage = storage;
        this._getSyncToken = getSyncToken;
        this._identityChangedForRoom = null;
        this._olmUtil = olmUtil;
        this._ownUserId = ownUserId;
        this._ownDeviceId = ownDeviceId;
    }

    async writeDeviceChanges(changed, txn, log) {
        const {userIdentities} = txn;
        // TODO: should we also look at left here to handle this?:
        // the usual problem here is that you share a room with a user,
        // go offline, the remote user leaves the room, changes their devices,
        // then rejoins the room you share (or another room).
        // At which point you come online, all of this happens in the gap, 
        // and you don't notice that they ever left, 
        // and so the client doesn't invalidate their device cache for the user
        log.set("changed", changed.length);
        await Promise.all(changed.map(async userId => {
            const user = await userIdentities.get(userId);
            if (user) {
                log.log({l: "outdated", id: userId});
                user.deviceTrackingStatus = TRACKING_STATUS_OUTDATED;
                userIdentities.set(user);
            }
        }));
    }

    writeMemberChanges(room, memberChanges, txn) {
        return Promise.all(Array.from(memberChanges.values()).map(async memberChange => {
            return this._applyMemberChange(memberChange, txn);
        }));
    }

    async trackRoom(room, log) {
        if (room.isTrackingMembers || !room.isEncrypted) {
            return;
        }
        const memberList = await room.loadMemberList(log);
        try {
            const txn = await this._storage.readWriteTxn([
                this._storage.storeNames.roomSummary,
                this._storage.storeNames.userIdentities,
            ]);
            let isTrackingChanges;
            try {
                isTrackingChanges = room.writeIsTrackingMembers(true, txn);
                const members = Array.from(memberList.members.values());
                log.set("members", members.length);
                await this._writeJoinedMembers(members, txn);
            } catch (err) {
                txn.abort();
                throw err;
            }
            await txn.complete();
            room.applyIsTrackingMembersChanges(isTrackingChanges);
        } finally {
            memberList.release();
        }
    }

    async _writeJoinedMembers(members, txn) {
        await Promise.all(members.map(async member => {
            if (member.membership === "join") {
                await this._writeMember(member, txn);
            }
        }));
    }

    async _writeMember(member, txn) {
        const {userIdentities} = txn;
        const identity = await userIdentities.get(member.userId);
        const updatedIdentity = addRoomToIdentity(identity, member.userId, member.roomId);
        if (updatedIdentity) {
            userIdentities.set(updatedIdentity);
        }
    }

    async _removeRoomFromUserIdentity(roomId, userId, txn) {
        const {userIdentities, deviceIdentities} = txn;
        const identity = await userIdentities.get(userId);
        if (identity) {
            identity.roomIds = identity.roomIds.filter(id => id !== roomId);
            // no more encrypted rooms with this user, remove
            if (identity.roomIds.length === 0) {
                userIdentities.remove(userId);
                deviceIdentities.removeAllForUser(userId);
            } else {
                userIdentities.set(identity);
            }
        }
    }

    async _applyMemberChange(memberChange, txn) {
        // TODO: depends whether we encrypt for invited users??
        // add room
        if (memberChange.hasJoined) {
            await this._writeMember(memberChange.member, txn);
        }
        // remove room
        else if (memberChange.hasLeft) {
            const {roomId} = memberChange;
            // if we left the room, remove room from all user identities in the room
            if (memberChange.userId === this._ownUserId) {
                const userIds = await txn.roomMembers.getAllUserIds(roomId);
                await Promise.all(userIds.map(userId => {
                    return this._removeRoomFromUserIdentity(roomId, userId, txn);
                }));
            } else {
                await this._removeRoomFromUserIdentity(roomId, memberChange.userId, txn);
            }
        }
    }

    async _queryKeys(userIds, hsApi, log) {
        // TODO: we need to handle the race here between /sync and /keys/query just like we need to do for the member list ...
        // there are multiple requests going out for /keys/query though and only one for /members

        const deviceKeyResponse = await hsApi.queryKeys({
            "timeout": 10000,
            "device_keys": userIds.reduce((deviceKeysMap, userId) => {
                deviceKeysMap[userId] = [];
                return deviceKeysMap;
            }, {}),
            "token": this._getSyncToken()
        }, {log}).response();

        const verifiedKeysPerUser = log.wrap("verify", log => this._filterVerifiedDeviceKeys(deviceKeyResponse["device_keys"], log));
        const txn = await this._storage.readWriteTxn([
            this._storage.storeNames.userIdentities,
            this._storage.storeNames.deviceIdentities,
        ]);
        let deviceIdentities;
        try {
            const devicesIdentitiesPerUser = await Promise.all(verifiedKeysPerUser.map(async ({userId, verifiedKeys}) => {
                const deviceIdentities = verifiedKeys.map(deviceKeysAsDeviceIdentity);
                return await this._storeQueriedDevicesForUserId(userId, deviceIdentities, txn);
            }));
            deviceIdentities = devicesIdentitiesPerUser.reduce((all, devices) => all.concat(devices), []);
            log.set("devices", deviceIdentities.length);
        } catch (err) {
            txn.abort();
            throw err;
        }
        await txn.complete();
        return deviceIdentities;
    }

    async _storeQueriedDevicesForUserId(userId, deviceIdentities, txn) {
        const knownDeviceIds = await txn.deviceIdentities.getAllDeviceIds(userId);
        // delete any devices that we know off but are not in the response anymore.
        // important this happens before checking if the ed25519 key changed,
        // otherwise we would end up deleting existing devices with changed keys.
        for (const deviceId of knownDeviceIds) {
            if (deviceIdentities.every(di => di.deviceId !== deviceId)) {
                txn.deviceIdentities.remove(userId, deviceId);
            }
        }

        // all the device identities as we will have them in storage
        const allDeviceIdentities = [];
        const deviceIdentitiesToStore = [];
        // filter out devices that have changed their ed25519 key since last time we queried them
        await Promise.all(deviceIdentities.map(async deviceIdentity => {
            if (knownDeviceIds.includes(deviceIdentity.deviceId)) {
                const existingDevice = await txn.deviceIdentities.get(deviceIdentity.userId, deviceIdentity.deviceId);
                if (existingDevice.ed25519Key !== deviceIdentity.ed25519Key) {
                    allDeviceIdentities.push(existingDevice);
                    return;
                }
            }
            allDeviceIdentities.push(deviceIdentity);
            deviceIdentitiesToStore.push(deviceIdentity);
        }));
        // store devices
        for (const deviceIdentity of deviceIdentitiesToStore) {
            txn.deviceIdentities.set(deviceIdentity);
        }
        // mark user identities as up to date
        const identity = await txn.userIdentities.get(userId);
        identity.deviceTrackingStatus = TRACKING_STATUS_UPTODATE;
        txn.userIdentities.set(identity);

        return allDeviceIdentities;
    }

    /**
     * @return {Array<{userId, verifiedKeys: Array<DeviceSection>>}
     */
    _filterVerifiedDeviceKeys(keyQueryDeviceKeysResponse, parentLog) {
        const curve25519Keys = new Set();
        const verifiedKeys = Object.entries(keyQueryDeviceKeysResponse).map(([userId, keysByDevice]) => {
            const verifiedEntries = Object.entries(keysByDevice).filter(([deviceId, deviceKeys]) => {
                const deviceIdOnKeys = deviceKeys["device_id"];
                const userIdOnKeys = deviceKeys["user_id"];
                if (userIdOnKeys !== userId) {
                    return false;
                }
                if (deviceIdOnKeys !== deviceId) {
                    return false;
                }
                const ed25519Key = deviceKeys.keys?.[`ed25519:${deviceId}`];
                const curve25519Key = deviceKeys.keys?.[`curve25519:${deviceId}`];
                if (typeof ed25519Key !== "string" || typeof curve25519Key !== "string") {
                    return false;
                }
                if (curve25519Keys.has(curve25519Key)) {
                    parentLog.log({
                        l: "ignore device with duplicate curve25519 key",
                        keys: deviceKeys
                    }, parentLog.level.Warn);
                    return false;
                }
                curve25519Keys.add(curve25519Key);
                const isValid = this._hasValidSignature(deviceKeys, parentLog);
                if (!isValid) {
                    parentLog.log({
                        l: "ignore device with invalid signature",
                        keys: deviceKeys
                    }, parentLog.level.Warn);
                }
                return isValid;
            });
            const verifiedKeys = verifiedEntries.map(([, deviceKeys]) => deviceKeys);
            return {userId, verifiedKeys};
        });
        return verifiedKeys;
    }

    _hasValidSignature(deviceSection, parentLog) {
        const deviceId = deviceSection["device_id"];
        const userId = deviceSection["user_id"];
        const ed25519Key = deviceSection?.keys?.[`${SIGNATURE_ALGORITHM}:${deviceId}`];
        return verifyEd25519Signature(this._olmUtil, userId, deviceId, ed25519Key, deviceSection, parentLog);
    }

    /**
     * Gives all the device identities for a room that is already tracked.
     * Assumes room is already tracked. Call `trackRoom` first if unsure.
     * @param  {String} roomId [description]
     * @return {[type]}        [description]
     */
    async devicesForTrackedRoom(roomId, hsApi, log) {
        const txn = await this._storage.readTxn([
            this._storage.storeNames.roomMembers,
            this._storage.storeNames.userIdentities,
        ]);

        // because we don't have multiEntry support in IE11, we get a set of userIds that is pretty close to what we
        // need as a good first filter (given that non-join memberships will be in there). After fetching the identities,
        // we check which ones have the roomId for the room we're looking at.
        
        // So, this will also contain non-joined memberships
        const userIds = await txn.roomMembers.getAllUserIds(roomId);

        return await this._devicesForUserIds(roomId, userIds, txn, hsApi, log);
    }

    /** gets devices for the given user ids that are in the given room */
    async devicesForRoomMembers(roomId, userIds, hsApi, log) {
        const txn = await this._storage.readTxn([
            this._storage.storeNames.userIdentities,
        ]);
        return await this._devicesForUserIds(roomId, userIds, txn, hsApi, log);
    }

    /** gets a single device */
    async deviceForId(userId, deviceId, hsApi, log) {
        const txn = await this._storage.readTxn([
            this._storage.storeNames.deviceIdentities,
        ]);
        let device = await txn.deviceIdentities.get(userId, deviceId);
        if (device) {
            log.set("existingDevice", true);
        } else {
            //// BEGIN EXTRACT (deviceKeysMap)
            const deviceKeyResponse = await hsApi.queryKeys({
                "timeout": 10000,
                "device_keys": {
                    [userId]: [deviceId]
                },
                "token": this._getSyncToken()
            }, {log}).response();
            // verify signature
            const verifiedKeysPerUser = log.wrap("verify", log => this._filterVerifiedDeviceKeys(deviceKeyResponse["device_keys"], log));
            //// END EXTRACT

            // there should only be one device in here, but still check the HS sends us the right one
            const verifiedKeys = verifiedKeysPerUser
                .find(vkpu => vkpu.userId === userId).verifiedKeys
                .find(vk => vk["device_id"] === deviceId);
            device = deviceKeysAsDeviceIdentity(verifiedKeys);
            const txn = await this._storage.readWriteTxn([
                this._storage.storeNames.deviceIdentities,
            ]);
            // check again we don't have the device already.
            // when updating all keys for a user we allow updating the
            // device when the key hasn't changed so the device display name
            // can be updated, but here we don't.
            const existingDevice = await txn.deviceIdentities.get(userId, deviceId);
            if (existingDevice) {
                device = existingDevice;
                log.set("existingDeviceAfterFetch", true);
            } else {
                try {
                    txn.deviceIdentities.set(device);
                    log.set("newDevice", true);
                } catch (err) {
                    txn.abort();
                    throw err;
                }
                await txn.complete();
            }
        }
        return device;
    }

    /**
     * @param  {string} roomId  [description]
     * @param  {Array<string>} userIds a set of user ids to try and find the identity for. Will be check to belong to roomId.
     * @param  {Transaction} userIdentityTxn to read the user identities
     * @param  {HomeServerApi} hsApi
     * @return {Array<DeviceIdentity>}
     */
    async _devicesForUserIds(roomId, userIds, userIdentityTxn, hsApi, log) {
        const allMemberIdentities = await Promise.all(userIds.map(userId => userIdentityTxn.userIdentities.get(userId)));
        const identities = allMemberIdentities.filter(identity => {
            // identity will be missing for any userIds that don't have 
            // membership join in any of your encrypted rooms
            return identity && identity.roomIds.includes(roomId);
        });
        const upToDateIdentities = identities.filter(i => i.deviceTrackingStatus === TRACKING_STATUS_UPTODATE);
        const outdatedIdentities = identities.filter(i => i.deviceTrackingStatus === TRACKING_STATUS_OUTDATED);
        log.set("uptodate", upToDateIdentities.length);
        log.set("outdated", outdatedIdentities.length);
        let queriedDevices;
        if (outdatedIdentities.length) {
            // TODO: ignore the race between /sync and /keys/query for now,
            // where users could get marked as outdated or added/removed from the room while
            // querying keys
            queriedDevices = await this._queryKeys(outdatedIdentities.map(i => i.userId), hsApi, log);
        }

        const deviceTxn = await this._storage.readTxn([
            this._storage.storeNames.deviceIdentities,
        ]);
        const devicesPerUser = await Promise.all(upToDateIdentities.map(identity => {
            return deviceTxn.deviceIdentities.getAllForUserId(identity.userId);
        }));
        let flattenedDevices = devicesPerUser.reduce((all, devicesForUser) => all.concat(devicesForUser), []);
        if (queriedDevices && queriedDevices.length) {
            flattenedDevices = flattenedDevices.concat(queriedDevices);
        }
        // filter out our own device
        const devices = flattenedDevices.filter(device => {
            const isOwnDevice = device.userId === this._ownUserId && device.deviceId === this._ownDeviceId;
            return !isOwnDevice;
        });
        return devices;
    }

    async getDeviceByCurve25519Key(curve25519Key, txn) {
        return await txn.deviceIdentities.getByCurve25519Key(curve25519Key);
    }
}

import {createMockStorage} from "../../mocks/Storage";
import {Instance as NullLoggerInstance} from "../../logging/NullLogger";

export function tests() {

    function createUntrackedRoomMock(roomId, joinedUserIds, invitedUserIds = []) {
        return {
            isTrackingMembers: false,
            isEncrypted: true,
            loadMemberList: () => {
                const joinedMembers = joinedUserIds.map(userId => {return {membership: "join", roomId, userId};});
                const invitedMembers = invitedUserIds.map(userId => {return {membership: "invite", roomId, userId};});
                const members = joinedMembers.concat(invitedMembers);
                const memberMap = members.reduce((map, member) => {
                    map.set(member.userId, member);
                    return map;
                }, new Map());
                return {members: memberMap, release() {}}
            },
            writeIsTrackingMembers(isTrackingMembers) {
                if (this.isTrackingMembers !== isTrackingMembers) {
                    return isTrackingMembers;
                }
                return undefined;
            },
            applyIsTrackingMembersChanges(isTrackingMembers) {
                if (isTrackingMembers !== undefined) {
                    this.isTrackingMembers = isTrackingMembers;
                }
            },
        }
    }

    function createQueryKeysHSApiMock(createKey = (algorithm, userId, deviceId) => `${algorithm}:${userId}:${deviceId}:key`) {
        return {
            queryKeys(payload) {
                const {device_keys: deviceKeys} = payload;
                const userKeys = Object.entries(deviceKeys).reduce((userKeys, [userId, deviceIds]) => {
                    if (deviceIds.length === 0) {
                        deviceIds = ["device1"];
                    }
                    userKeys[userId] = deviceIds.filter(d => d === "device1").reduce((deviceKeys, deviceId) => {
                        deviceKeys[deviceId] = {
                            "algorithms": [
                              "m.olm.v1.curve25519-aes-sha2",
                              "m.megolm.v1.aes-sha2"
                            ],
                            "device_id": deviceId,
                            "keys": {
                                [`curve25519:${deviceId}`]: createKey("curve25519", userId, deviceId),
                                [`ed25519:${deviceId}`]: createKey("ed25519", userId, deviceId),
                            },
                            "signatures": {
                                [userId]: {
                                    [`ed25519:${deviceId}`]: `ed25519:${userId}:${deviceId}:signature`
                                }
                            },
                            "unsigned": {
                              "device_display_name": `${userId} Phone`
                            },
                            "user_id": userId
                        };
                        return deviceKeys;
                    }, {});
                    return userKeys;
                }, {});
                const response = {device_keys: userKeys};
                return {
                    async response() {
                        return response;
                    }
                };
            }
        };
    }
    const roomId = "!abc:hs.tld";

    return {
        "trackRoom only writes joined members": async assert => {
            const storage = await createMockStorage();
            const tracker = new DeviceTracker({
                storage,
                getSyncToken: () => "token",
                olmUtil: {ed25519_verify: () => {}}, // valid if it does not throw
                ownUserId: "@alice:hs.tld",
                ownDeviceId: "ABCD",
            });
            const room = createUntrackedRoomMock(roomId, ["@alice:hs.tld", "@bob:hs.tld"], ["@charly:hs.tld"]);
            await tracker.trackRoom(room, NullLoggerInstance.item);
            const txn = await storage.readTxn([storage.storeNames.userIdentities]);
            assert.deepEqual(await txn.userIdentities.get("@alice:hs.tld"), {
                userId: "@alice:hs.tld",
                roomIds: [roomId],
                deviceTrackingStatus: TRACKING_STATUS_OUTDATED
            });
            assert.deepEqual(await txn.userIdentities.get("@bob:hs.tld"), {
                userId: "@bob:hs.tld",
                roomIds: [roomId],
                deviceTrackingStatus: TRACKING_STATUS_OUTDATED
            });
            assert.equal(await txn.userIdentities.get("@charly:hs.tld"), undefined);
        },
        "getting devices for tracked room yields correct keys": async assert => {
            const storage = await createMockStorage();
            const tracker = new DeviceTracker({
                storage,
                getSyncToken: () => "token",
                olmUtil: {ed25519_verify: () => {}}, // valid if it does not throw
                ownUserId: "@alice:hs.tld",
                ownDeviceId: "ABCD",
            });
            const room = createUntrackedRoomMock(roomId, ["@alice:hs.tld", "@bob:hs.tld"]);
            await tracker.trackRoom(room, NullLoggerInstance.item);
            const hsApi = createQueryKeysHSApiMock();
            const devices = await tracker.devicesForRoomMembers(roomId, ["@alice:hs.tld", "@bob:hs.tld"], hsApi, NullLoggerInstance.item);
            assert.equal(devices.length, 2);
            assert.equal(devices.find(d => d.userId === "@alice:hs.tld").ed25519Key, "ed25519:@alice:hs.tld:device1:key");
            assert.equal(devices.find(d => d.userId === "@bob:hs.tld").ed25519Key, "ed25519:@bob:hs.tld:device1:key");
        },
        "device with changed key is ignored": async assert => {
            const storage = await createMockStorage();
            const tracker = new DeviceTracker({
                storage,
                getSyncToken: () => "token",
                olmUtil: {ed25519_verify: () => {}}, // valid if it does not throw
                ownUserId: "@alice:hs.tld",
                ownDeviceId: "ABCD",
            });
            const room = createUntrackedRoomMock(roomId, ["@alice:hs.tld", "@bob:hs.tld"]);
            await tracker.trackRoom(room, NullLoggerInstance.item);
            const hsApi = createQueryKeysHSApiMock();
            // query devices first time
            await tracker.devicesForRoomMembers(roomId, ["@alice:hs.tld", "@bob:hs.tld"], hsApi, NullLoggerInstance.item);
            const txn = await storage.readWriteTxn([storage.storeNames.userIdentities]);
            // mark alice as outdated, so keys will be fetched again
            tracker.writeDeviceChanges(["@alice:hs.tld"], txn, NullLoggerInstance.item);
            await txn.complete();
            const hsApiWithChangedAliceKey = createQueryKeysHSApiMock((algo, userId, deviceId) => {
                return `${algo}:${userId}:${deviceId}:${userId === "@alice:hs.tld" ? "newKey" : "key"}`;
            });
            const devices = await tracker.devicesForRoomMembers(roomId, ["@alice:hs.tld", "@bob:hs.tld"], hsApiWithChangedAliceKey, NullLoggerInstance.item);
            assert.equal(devices.length, 2);
            assert.equal(devices.find(d => d.userId === "@alice:hs.tld").ed25519Key, "ed25519:@alice:hs.tld:device1:key");
            assert.equal(devices.find(d => d.userId === "@bob:hs.tld").ed25519Key, "ed25519:@bob:hs.tld:device1:key");
            const txn2 = await storage.readTxn([storage.storeNames.deviceIdentities]);
            // also check the modified key was not stored
            assert.equal((await txn2.deviceIdentities.get("@alice:hs.tld", "device1")).ed25519Key, "ed25519:@alice:hs.tld:device1:key");
        }
    }
}
