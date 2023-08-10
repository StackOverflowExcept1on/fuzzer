import {Keyring} from "@polkadot/api";
import {BN} from "@polkadot/util";
import {cryptoWaitReady} from "@polkadot/util-crypto";
import {deriveAddress, KeyringPair} from "@substrate/txwrapper-core";
import {decodeAddress, GearApi, getProgramMetadata, GearKeyring} from "@gear-js/api";
import * as fs from "fs";
import * as crypto from "crypto";

const main = async () => {
    // config
    const PROGRAM_WASM = "./program/tic_tac_toe.opt.wasm";
    const PROGRAM_META = "./program/tic_tac_toe.meta.txt";
    const PROGRAM_INIT = {
        config: {
            tokensOnLose: 0,
            tokensOnDraw: 0,
            tokensOnWin: 0,
        }
    };
    const PROGRAM_ACTION = {
        StartGame: {},
    };

    const NUMBER_OF_ACCOUNTS = 1000;

    // init Alice account
    await cryptoWaitReady();

    const aliceKeypair = new Keyring().addFromUri("//Alice", {name: "Alice"}, "sr25519");
    const aliceAddress = deriveAddress(aliceKeypair.publicKey, 42);

    console.log(`Alice address: ${aliceAddress}`);

    // connect to gear node
    const api = new GearApi({providerAddress: "ws://localhost:9944"});
    try {
        await api.isReadyOrError;
    } catch (err) {
        throw new Error("Unable to connect to node");
    }

    // get metadata for program
    const meta = getProgramMetadata(fs.readFileSync(PROGRAM_META, "utf-8"));

    // upload program or just get first program from node
    const programs = await api.program.allUploadedPrograms();
    if (programs.length === 0) {
        console.log("Uploading program to node...");

        const code = fs.readFileSync(PROGRAM_WASM);
        const initPayload = PROGRAM_INIT;

        const gasInfo = await api.program.calculateGas.initUpload(
            decodeAddress(aliceKeypair.address),
            code,
            initPayload,
            0,
            true,
            meta,
            meta.types.init.input!,
        );
        const gasLimit = gasInfo.min_limit;

        console.log(`Gas limit: ${gasLimit}`);

        const program = {
            code,
            gasLimit,
            initPayload,
        };

        api.program.upload(program, meta, meta.types.init.input!);

        try {
            await new Promise((resolve, reject) => {
                api.program.signAndSend(aliceKeypair, ({events, status}) => {
                    console.log(`Status: ${status.toString()}`);
                    if (status.isFinalized) resolve(status.asFinalized);
                    events.forEach(({event}) => {
                        if (event.method === "ExtrinsicFailed") {
                            reject(api.getExtrinsicFailedError(event).docs.join('\n'));
                        }
                    });
                });
            });
        } catch (error) {
            console.log(error);
        }
    }

    const programId = (await api.program.allUploadedPrograms())[0];
    console.log(`ProgramId: ${programId}`);

    // generate random accounts

    const accounts: { keyring: KeyringPair, mnemonic: string }[] = [];

    for (let i = 0; i < NUMBER_OF_ACCOUNTS; ++i) {
        const {keyring, mnemonic} = await GearKeyring.create(crypto.randomBytes(32).toString("hex"));
        accounts.push({keyring, mnemonic});
    }

    // send funds to accounts

    const decimals = new BN(12);
    const amount = new BN(1_000);
    const value = amount.mul(new BN(10).pow(decimals));

    for (let account of accounts) {
        const tx = api.balance.transfer(account.keyring.address, value);

        const nonce = await api.rpc.system.accountNextIndex(deriveAddress(aliceKeypair.publicKey, 42));
        await tx.signAndSend(aliceKeypair, {nonce});
    }

    // start game from created accounts

    let counter = 1;
    for (let account of accounts) {
        const payload = PROGRAM_ACTION;

        const gasInfo = await api.program.calculateGas.handle(
            decodeAddress(aliceKeypair.address),
            programId,
            payload,
            0,
            true,
            meta,
            meta?.types.handle.input!,
        );
        const gasLimit = gasInfo.min_limit;

        console.log(`sent ${counter} / ${NUMBER_OF_ACCOUNTS}, gas limit: ${gasLimit}`);
        counter += 1;

        const tx = api.message.send({
            destination: programId,
            payload,
            gasLimit,
        }, meta);

        const nonce = await api.rpc.system.accountNextIndex(deriveAddress(account.keyring.publicKey, 42));
        await tx.signAndSend(account.keyring, {nonce});
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.log(error);
        process.exit(1);
    });
