/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

import {PeerCall, CallState} from "../PeerCall";
import {makeTxnId, makeId} from "../../common";
import {EventType, CallErrorCode} from "../callEventTypes";
import {formatToDeviceMessagesPayload} from "../../common";

import type {Options as PeerCallOptions, RemoteMedia} from "../PeerCall";
import type {LocalMedia} from "../LocalMedia";
import type {HomeServerApi} from "../../net/HomeServerApi";
import type {MCallBase, MGroupCallBase, SignallingMessage, CallDeviceMembership} from "../callEventTypes";
import type {GroupCall} from "./GroupCall";
import type {RoomMember} from "../../room/members/RoomMember";
import type {EncryptedMessage} from "../../e2ee/olm/Encryption";
import type {ILogItem} from "../../../logging/types";

export type Options = Omit<PeerCallOptions, "emitUpdate" | "sendSignallingMessage"> & {
    confId: string,
    ownUserId: string,
    ownDeviceId: string,
    sessionId: string,
    hsApi: HomeServerApi,
    encryptDeviceMessage: (userId: string, message: SignallingMessage<MGroupCallBase>, log: ILogItem) => Promise<EncryptedMessage>,
    emitUpdate: (participant: Member, params?: any) => void,
}

const errorCodesWithoutRetry = [
    CallErrorCode.UserHangup,
    CallErrorCode.AnsweredElsewhere,
    CallErrorCode.Replaced,
    CallErrorCode.UserBusy,
    CallErrorCode.Transfered,
    CallErrorCode.NewSession
];

export class Member {
    private peerCall?: PeerCall;
    private localMedia?: LocalMedia;
    private retryCount: number = 0;

    constructor(
        public readonly member: RoomMember,
        private callDeviceMembership: CallDeviceMembership,
        private readonly options: Options,
        private readonly logItem: ILogItem,
    ) {}

    get remoteMedia(): RemoteMedia | undefined {
        return this.peerCall?.remoteMedia;
    }

    get isConnected(): boolean {
        return this.peerCall?.state === CallState.Connected;
    }

    get userId(): string {
        return this.member.userId;
    }

    get deviceId(): string {
        return this.callDeviceMembership.device_id;
    }

    get dataChannel(): any | undefined {
        return this.peerCall?.dataChannel;
    }

    /** @internal */
    connect(localMedia: LocalMedia) {
        this.logItem.wrap("connect", () => {
            this.localMedia = localMedia;
            // otherwise wait for it to connect
            let shouldInitiateCall;
            // the lexicographically lower side initiates the call
            if (this.member.userId === this.options.ownUserId) {
                shouldInitiateCall = this.deviceId > this.options.ownDeviceId;
            } else {
                shouldInitiateCall = this.member.userId > this.options.ownUserId;
            }
            if (shouldInitiateCall) {
                this.peerCall = this._createPeerCall(makeId("c"));
                this.peerCall.call(localMedia);
            }
        });
    }

    /** @internal */
    disconnect(hangup: boolean) {
        this.logItem.wrap("disconnect", log => {
            if (hangup) {
                this.peerCall?.hangup(CallErrorCode.UserHangup);
            } else {
                this.peerCall?.close(undefined, log);
            }
            this.peerCall?.dispose();
            this.peerCall = undefined;
            this.localMedia?.dispose();
            this.localMedia = undefined;
        });
    }

    /** @internal */
    updateCallInfo(callDeviceMembership: CallDeviceMembership) {
        this.callDeviceMembership = callDeviceMembership;
    }

    /** @internal */
    emitUpdate = (peerCall: PeerCall, params: any) => {
        if (peerCall.state === CallState.Ringing) {
            peerCall.answer(this.localMedia!);
        }
        else if (peerCall.state === CallState.Ended) {
            const hangupReason = peerCall.hangupReason;
            peerCall.dispose();
            this.peerCall = undefined;
            if (hangupReason && !errorCodesWithoutRetry.includes(hangupReason)) {
                this.retryCount += 1;
                if (this.retryCount <= 3) {
                    this.connect(this.localMedia!);
                }
            }
        }
        this.options.emitUpdate(this, params);
    }

    /** @internal */
    sendSignallingMessage = async (message: SignallingMessage<MCallBase>, log: ILogItem): Promise<void> => {
        const groupMessage = message as SignallingMessage<MGroupCallBase>;
        groupMessage.content.conf_id = this.options.confId;
        groupMessage.content.device_id = this.options.ownDeviceId;
        groupMessage.content.party_id = this.options.ownDeviceId;
        groupMessage.content.sender_session_id = this.options.sessionId;
        groupMessage.content.dest_session_id = this.callDeviceMembership.session_id;
        // const encryptedMessages = await this.options.encryptDeviceMessage(this.member.userId, groupMessage, log);
        // const payload = formatToDeviceMessagesPayload(encryptedMessages);
        const payload = {
            messages: {
                [this.member.userId]: {
                    [this.deviceId]: groupMessage.content
                }
            }
        };
        const request = this.options.hsApi.sendToDevice(
            message.type,
            //"m.room.encrypted",
            payload,
            makeTxnId(),
            {log}
        );
        await request.response();
    }

    /** @internal */
    handleDeviceMessage(message: SignallingMessage<MGroupCallBase>, deviceId: string, syncLog: ILogItem) {
        syncLog.refDetached(this.logItem);
        const destSessionId = message.content.dest_session_id;
        if (destSessionId !== this.options.sessionId) {
            this.logItem.log({l: "ignoring to_device event with wrong session_id", destSessionId, type: message.type});
            return;
        }
        if (message.type === EventType.Invite && !this.peerCall) {
            this.peerCall = this._createPeerCall(message.content.call_id);
        }
        if (this.peerCall) {
            this.peerCall.handleIncomingSignallingMessage(message, deviceId);
        } else {
            // TODO: need to buffer events until invite comes?
        }
    }

    /** @internal */
    async setMedia(localMedia: LocalMedia): Promise<void> {
        const oldMedia = this.localMedia;
        this.localMedia = localMedia;
        await this.peerCall?.setMedia(localMedia);
        oldMedia?.dispose();
    }

    private _createPeerCall(callId: string): PeerCall {
        return new PeerCall(callId, Object.assign({}, this.options, {
            emitUpdate: this.emitUpdate,
            sendSignallingMessage: this.sendSignallingMessage
        }), this.logItem);
    }
}