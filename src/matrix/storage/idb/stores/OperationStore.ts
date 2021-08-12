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
import {MIN_UNICODE, MAX_UNICODE} from "./common";
import {Store} from "../Store"

export function encodeScopeTypeKey(scope: string, type: string): string {
    return `${scope}|${type}`;
}

interface Operation {
    id: string
    type: string
    scope: string
    userIds: string[]
    scopeTypeKey: string
    roomKeyMessage: RoomKeyMessage
}

interface RoomKeyMessage {
    room_id: string
    session_id: string
    session_key: string
    algorithm: string
    chain_index: number
}

export class OperationStore {
    private _store: Store<Operation>

    constructor(store: Store<Operation>) {
        this._store = store;
    }

    getAll(): Promise<Operation[]> {
        return this._store.selectAll();
    }

    async getAllByTypeAndScope(type: string, scope: string): Promise<Operation[]> {
        const key = encodeScopeTypeKey(scope, type);
        const results: Operation[] = [];
        await this._store.index("byScopeAndType").iterateWhile(key, value => {
            if (value.scopeTypeKey !== key) {
                return false;
            }
            results.push(value);
            return true;
        });
        return results;
    }

    add(operation: Operation): Promise<IDBValidKey> {
        operation.scopeTypeKey = encodeScopeTypeKey(operation.scope, operation.type);
        return this._store.add(operation);
    }

    update(operation: Operation): Promise<IDBValidKey> {
        return this._store.put(operation);
    }

    remove(id: string): Promise<undefined> {
        return this._store.delete(id);
    }

    async removeAllForScope(scope: string): Promise<undefined> {
        const range = this._store.IDBKeyRange.bound(
            encodeScopeTypeKey(scope, MIN_UNICODE),
            encodeScopeTypeKey(scope, MAX_UNICODE)
        );
        const index = this._store.index("byScopeAndType");
        await index.iterateValues(range, (_, __, cur) => {
            cur.delete();
            return true;
        });
        return;
    }
}
