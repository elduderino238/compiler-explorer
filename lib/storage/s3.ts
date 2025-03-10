// Copyright (c) 2018, Compiler Explorer Authors
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//     * Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

import assert from 'node:assert';

import {DynamoDB} from '@aws-sdk/client-dynamodb';
import * as express from 'express';
import _ from 'underscore';

import {unwrap} from '../assert.js';
import {awsCredentials} from '../aws.js';
import {logger} from '../logger.js';
import {PropertyGetter} from '../properties.interfaces.js';
import {CompilerProps} from '../properties.js';
import {S3Bucket} from '../s3-handler.js';
import {anonymizeIp} from '../utils.js';

import {ExpandedShortLink, StorageBase, StoredObject} from './base.js';

/*
 * NEVER CHANGE THIS VALUE
 *
 * This value does not control the length of generated
 * short links. It is purely an implementation detail
 * of the underlying dynamodb table, and changing it
 * will break all existing links in the database.
 */
const PREFIX_LENGTH = 6;

/*
 * This value can be changed freely to control the minimum
 * generated link length.
 *
 * Changing it will have no impact on existing links.
 */
const MIN_STORED_ID_LENGTH = 9;

assert(MIN_STORED_ID_LENGTH >= PREFIX_LENGTH, 'MIN_STORED_ID_LENGTH must be at least PREFIX_LENGTH');

export type TestReq = {
    get: () => string;
    ip?: string;
};

export class StorageS3 extends StorageBase {
    static get key() {
        return 's3';
    }

    protected readonly prefix: string;
    protected readonly table: string;
    protected readonly s3: S3Bucket;
    protected readonly dynamoDb: DynamoDB;

    constructor(httpRootDir: string, compilerProps: CompilerProps | PropertyGetter, awsProps: PropertyGetter) {
        super(httpRootDir, compilerProps);
        const region = awsProps('region') as string;
        const bucket = awsProps('storageBucket') as string;
        this.prefix = awsProps('storagePrefix') as string;
        this.table = awsProps('storageDynamoTable') as string;
        logger.info(
            `Using s3 storage solution on ${region}, bucket ${bucket}, ` +
                `prefix ${this.prefix}, dynamo table ${this.table}`,
        );
        this.s3 = new S3Bucket(bucket, region);
        this.dynamoDb = new DynamoDB({region: region, credentials: awsCredentials()});
    }

    async storeItem(item: StoredObject, req: express.Request | TestReq) {
        logger.info(`Storing item ${item.prefix}`);
        const now = new Date();
        let ip = req.get('X-Forwarded-For') || anonymizeIp(req.ip!);
        const commaIndex = ip.indexOf(',');
        if (commaIndex > 0) {
            // Anonymize only client IP
            ip = `${anonymizeIp(ip.substring(0, commaIndex))}${ip.substring(commaIndex, ip.length)}`;
        }
        now.setSeconds(0, 0);
        try {
            await Promise.all([
                this.dynamoDb.putItem({
                    TableName: this.table,
                    Item: {
                        prefix: {S: item.prefix},
                        unique_subhash: {S: item.uniqueSubHash},
                        full_hash: {S: item.fullHash},
                        stats: {
                            M: {clicks: {N: '0'}},
                        },
                        creation_ip: {S: ip},
                        creation_date: {S: now.toISOString()},
                    },
                }),
                this.s3.put(item.fullHash, item.config as any as Buffer, this.prefix, {}),
            ]);
            return item;
        } catch (err) {
            logger.error('Unable to store item', {item, err});
            throw err;
        }
    }

    async findUniqueSubhash(hash: string) {
        const prefix = hash.substring(0, PREFIX_LENGTH);
        const data = await this.dynamoDb.query({
            TableName: this.table,
            ProjectionExpression: 'unique_subhash, full_hash',
            KeyConditionExpression: 'prefix = :prefix',
            ExpressionAttributeValues: {':prefix': {S: prefix}},
        });
        const subHashes = _.chain(data.Items).pluck('unique_subhash').pluck('S').value();
        const fullHashes = _.chain(data.Items).pluck('full_hash').pluck('S').value();
        for (let i = MIN_STORED_ID_LENGTH; i < hash.length - 1; i++) {
            const subHash = hash.substring(0, i);
            // Check if the current base is present in the subHashes array
            const index = _.indexOf(subHashes, subHash, true);
            if (index === -1) {
                // Current base is not present, we have a new config in our hands
                return {
                    prefix: prefix,
                    uniqueSubHash: subHash,
                    alreadyPresent: false,
                };
            }
            const itemHash = fullHashes[index];
            /* If the hashes coincide, it means this config has already been stored.
             * Else, keep looking
             */
            if (itemHash === hash) {
                return {
                    prefix: prefix,
                    uniqueSubHash: subHash,
                    alreadyPresent: true,
                };
            }
        }
        throw new Error(`Could not find unique subhash for hash "${hash}"`);
    }

    getKeyStruct(id: string) {
        return {
            prefix: {S: id.substring(0, PREFIX_LENGTH)},
            unique_subhash: {S: id},
        };
    }

    async expandId(id: string): Promise<ExpandedShortLink> {
        // By just getting the item and not trying to update it, we save an update when the link does not exist
        // for which we have less resources allocated, but get one extra read (But we do have more reserved for it)
        const item = await this.dynamoDb.getItem({
            TableName: this.table,
            Key: this.getKeyStruct(id),
        });
        const attributes = item.Item;
        if (!attributes) throw new Error(`ID ${id} not present in links table`);
        const result = await this.s3.get(unwrap(attributes.full_hash.S), this.prefix);
        // If we're here, we are pretty confident there is a match. But never hurts to double check
        if (!result.hit) throw new Error(`ID ${id} not present in storage`);

        const link: ExpandedShortLink = {
            config: unwrap(result.data).toString(),
        };

        if (attributes.named_metadata) link.specialMetadata = attributes.named_metadata.M;

        if (attributes.creation_date?.S) link.created = new Date(attributes.creation_date.S);

        return link;
    }

    async incrementViewCount(id: string) {
        try {
            await this.dynamoDb.updateItem({
                TableName: this.table,
                Key: this.getKeyStruct(id),
                UpdateExpression: 'SET stats.clicks = stats.clicks + :inc',
                ExpressionAttributeValues: {
                    ':inc': {N: '1'},
                },
                ReturnValues: 'NONE',
            });
        } catch (err) {
            // Swallow up errors
            logger.error(`Error when incrementing view count for ${id}`, err);
        }
    }
}
