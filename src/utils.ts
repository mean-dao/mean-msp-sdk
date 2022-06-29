import { 
  Commitment, 
  Connection, 
  PublicKey, 
  ConfirmOptions, 
  Finality, 
  PartiallyDecodedInstruction, 
  LAMPORTS_PER_SOL, 
  ConfirmedSignaturesForAddress2Options, 
  Keypair, 
  TransactionInstruction, 
  SystemProgram, 
  AccountInfo, 
  ParsedTransactionWithMeta} from "@solana/web3.js";
import { BN, BorshInstructionCoder, Idl, Program, Event } from "@project-serum/anchor";
/**
 * MSP
 */
import { Constants, LATEST_IDL_FILE_VERSION } from "./constants";
import { StreamActivity, Stream, MSP_ACTIONS, TransactionFees, StreamActivityRaw } from "./types";
import { STREAM_STATUS, Treasury, TreasuryType } from "./types";
import { IDL, Msp } from './msp_idl_003'; // point to the latest IDL
import { bs58 } from "@project-serum/anchor/dist/cjs/utils/bytes";
import { AnchorProvider, Wallet } from "@project-serum/anchor/dist/cjs/provider";
import { AccountLayout, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, Token, TOKEN_PROGRAM_ID } from "@solana/spl-token";

type StreamEventType = Event<Msp['events'][0]>;

String.prototype.toPublicKey = function (): PublicKey {
  return new PublicKey(this.toString());
};

let defaultStreamActivity: StreamActivity = {
  signature: "",
  initializer: "",
  action: "",
  amount: 0,
  mint: "",
  blockTime: 0,
  utcDate: "",
};

export const createProgram = (
  connection: Connection,
  walletAddress: string

): Program<Msp> => {
  
  const opts: ConfirmOptions = {
    preflightCommitment: "finalized",
    commitment: "finalized",
  };

  let wallet: Wallet = {
    publicKey: new PublicKey(walletAddress),
    signAllTransactions: async (txs) => txs, 
    signTransaction: async (tx) => tx
  };

  const provider = new AnchorProvider(connection, wallet, opts);
  
  // return new Program(Msp, Constants.MSP, provider);
  return new Program(IDL, Constants.MSP, provider);
}

export const getStream = async (
  program: Program<Msp>,
  address: PublicKey,
  friendly: boolean = true

): Promise<any> => {
  
  try {

    const streamEventResponse = await program.simulate.getStream(
      LATEST_IDL_FILE_VERSION,
      {
      accounts: {
        stream: address
      }
    });
  
    if (
      !streamEventResponse || 
      !streamEventResponse.events || 
      !streamEventResponse.events.length ||
      !streamEventResponse.events[0].data
    ) {
      return null;
    }

    const event: StreamEventType = streamEventResponse.events[0];
    let streamInfo = parseGetStreamData(
      event, 
      address, 
      friendly
    );
  
    return streamInfo;

  } catch (error: any) {
    console.log(error);
    return null;
  }
}

export const getStreamCached = async (
  streamInfo: Stream,
  friendly: boolean = true

): Promise<Stream> => {

  const timeDiff = streamInfo.lastRetrievedTimeInSeconds - streamInfo.lastRetrievedBlockTime;
  const blocktime = parseInt((Date.now() / 1_000).toString()) - timeDiff;

  const parsedStream = parseStreamItemData(
    streamInfo.data,
    new PublicKey(streamInfo.id as string),
    blocktime,
    friendly
  );

  parsedStream.createdBlockTime = streamInfo.createdBlockTime;

  return parsedStream;
}

export const listStreams = async (
  program: Program<Msp>,
  treasurer?: PublicKey | undefined,
  treasury?: PublicKey | undefined,
  beneficiary?: PublicKey | undefined,
  friendly: boolean = true

): Promise<Stream[]> => {

  let streamInfoList: Stream[] = [];
  let accounts = await getFilteredStreamAccounts(program, treasurer, treasury, beneficiary);
  let slot = await program.provider.connection.getSlot("finalized");
  let blockTime = await program.provider.connection.getBlockTime(slot) as number;

  for (let item of accounts) {
    if (item.account !== undefined) {
      let parsedStream = parseStreamItemData(item.account, item.publicKey, blockTime, friendly);
      let info = Object.assign({ }, parsedStream);
      // let signatures = await program.provider.connection.getConfirmedSignaturesForAddress2(
      //   friendly ? new PublicKey(info.id as string) : (info.id as PublicKey),
      //   { limit: 1 }, 
      //   'confirmed'
      // );

      // if (signatures.length > 0) {
      //   info.createdBlockTime = signatures[0].blockTime as number;
      // }

      streamInfoList.push(info);
    }
  }

  let orderedStreams = streamInfoList.sort((a, b) => b.createdBlockTime - a.createdBlockTime);

  return orderedStreams;
}

export const listStreamsCached = async (
  streamInfoList: Stream[],
  friendly: boolean = true

): Promise<Stream[]> => {

  let streamList: Stream[] = [];

  for (let streamInfo of streamInfoList) {
    let timeDiff = streamInfo.lastRetrievedTimeInSeconds - streamInfo.lastRetrievedBlockTime;
    let blockTime = parseInt((Date.now() / 1_000).toString()) - timeDiff;
    
    let parsedStream = parseStreamItemData(
      streamInfo.data, 
      new PublicKey(streamInfo.id as string), 
      blockTime, 
      friendly
    );

    parsedStream.createdBlockTime = streamInfo.createdBlockTime;
    streamList.push(parsedStream);
  }  

  return streamList;
}

export const listStreamActivity = async (
  program: Program<Msp>,
  address: PublicKey,
  before: string = '',
  limit: number = 10,
  commitment?: Finality | undefined,
  friendly: boolean = true

): Promise<StreamActivityRaw[] | StreamActivity[]> => {

  let activityRaw: StreamActivityRaw[] = [];
  let finality = commitment !== undefined ? commitment : "finalized";
  let filter = { limit: limit } as ConfirmedSignaturesForAddress2Options;
  if (before) { filter['before'] = before };
  let signatures = await program.provider.connection.getConfirmedSignaturesForAddress2(address, filter, finality);
  let txs = await program.provider.connection.getParsedTransactions(signatures.map((s: any) => s.signature), finality);

  if (txs && txs.length) {
    activityRaw = await parseStreamTransactions(address, txs as ParsedTransactionWithMeta[]);

    activityRaw.sort(
      (a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0)
    );
  }

  if (!friendly) return activityRaw;

  const activity = activityRaw.map(i => {
    return {
      signature: i.signature,
      initializer: i.initializer?.toBase58(),
      action: i.action,
      amount: i.amount ? parseFloat(i.amount.toNumber().toFixed(9)) : 0,
      mint: i.mint?.toBase58(),
      blockTime: i.blockTime,
      utcDate: i.utcDate,
    } as StreamActivity
  });

  return activity;
}

export const getTreasury = async (
  program: Program<Msp>,
  address: PublicKey,
  friendly: boolean = true

): Promise<Treasury> => {

  let treasury = await program.account.treasury.fetch(address);
  let parsedTreasury = parseTreasuryData(treasury, address, friendly)

  return parsedTreasury;
}

export const listTreasuries = async (
  program: Program<Msp>,
  treasurer?: PublicKey | undefined,
  friendly: boolean = true

): Promise<Treasury[]> => {

  let treasuries: Treasury[] = [];
  let memcmpFilters: any[] = [];

  if (treasurer) {
    memcmpFilters.push({ memcmp: { offset: 8 + 43, bytes: treasurer.toBase58() }});
  }

  const accounts = await program.account.treasury.all(memcmpFilters);

  if (accounts.length) {
    for (let item of accounts) {
      if (item.account !== undefined) {
        let parsedTreasury = parseTreasuryData(item.account, item.publicKey, friendly);
        let info = Object.assign({}, parsedTreasury);

        if ((treasurer && treasurer.toBase58() === info.treasurer) || !treasurer) {
          treasuries.push(info);
        }
      }
    }
  }

  const sortedTreasuries = treasuries.sort((a, b) => b.slot - a.slot);

  return sortedTreasuries;
}

export const calculateActionFees = async (
  connection: Connection,
  action: MSP_ACTIONS

): Promise<TransactionFees> => {

  let recentBlockhash = await connection.getRecentBlockhash(connection.commitment as Commitment),
    blockchainFee = 0,
    txFees: TransactionFees = {
      blockchainFee: 0.0,
      mspFlatFee: 0.0,
      mspPercentFee: 0.0,
    };

  switch (action) {
    case MSP_ACTIONS.createTreasury: {
      blockchainFee = 15000000;
      txFees.mspFlatFee = 0.00001;
      break;
    }
    case MSP_ACTIONS.createStream: {
      blockchainFee = 15000000;
      txFees.mspFlatFee = 0.00001;
      break;
    }
    case MSP_ACTIONS.createStreamWithFunds: {
      blockchainFee = 20000000;
      txFees.mspFlatFee = 0.000035;
      break;
    }
    case MSP_ACTIONS.scheduleOneTimePayment: {
      blockchainFee = 15000000
      txFees.mspFlatFee = 0.000035;
      break;
    }
    case MSP_ACTIONS.addFunds: {
      txFees.mspFlatFee = 0.000025;
      break;
    }
    case MSP_ACTIONS.withdraw: {
      blockchainFee = 5000000;
      txFees.mspPercentFee = 0.25;
      break;
    }
    case MSP_ACTIONS.closeStream: {
      txFees.mspFlatFee = 0.00001;
      txFees.mspPercentFee = 0.25;
      break;
    }
    case MSP_ACTIONS.closeTreasury: {
      txFees.mspFlatFee = 0.00001;
      break;
    }
    case MSP_ACTIONS.transferStream: {
      blockchainFee = 5000;
      txFees.mspFlatFee = 0.00001;
      break;
    }
    case MSP_ACTIONS.treasuryWithdraw: {
      // txFees.mspFlatFee = 0.00001;
      txFees.mspPercentFee = 0.25;
      break;
    }
    default: {
      break;
    }
  }

  txFees.blockchainFee = blockchainFee / LAMPORTS_PER_SOL;

  return txFees;
};

export const getValidTreasuryAllocation = async (
  connection: Connection,
  treasury: Treasury,
  allocation: number

) => {

  const fees = await calculateActionFees(connection, MSP_ACTIONS.withdraw);
  //
  const BASE_100_TO_BASE_1_MULTIPLIER = 10_000;
  const feeNumerator = fees.mspPercentFee * BASE_100_TO_BASE_1_MULTIPLIER;
  const feeDenaminator = 1_000_000;
  const unallocatedBalance = new BN(treasury.balance).sub(new BN(treasury.allocationAssigned));
  const allocationAmountBn = new BN(allocation).add(unallocatedBalance);
  const badStreamAllocationAmount = allocationAmountBn
    .mul(new BN(feeDenaminator))
    .div(new BN(feeNumerator + feeDenaminator));

  const feeAmount = badStreamAllocationAmount
    .mul(new BN(feeNumerator))
    .div(new BN(feeDenaminator));
  
  if (unallocatedBalance.gte(feeAmount)) {
    return badStreamAllocationAmount;
  }

  const goodStreamMaxAllocation = allocationAmountBn.sub(feeAmount);

  return goodStreamMaxAllocation;
}

const getFilteredStreamAccounts = async (
  program: Program<Msp>,
  treasurer?: PublicKey | undefined,
  treasury?: PublicKey | undefined,
  beneficiary?: PublicKey | undefined

) => {

  let accounts: any[] = [];

  if (treasury) {

    let memcmpFilters = [{ memcmp: { offset: 8 + 170, bytes: treasury.toBase58() }}];
    const accs = await program.account.stream.all(memcmpFilters);
  
    if (accs.length) {
      accounts.push(...accs);
    }

  } else {

    if (treasurer) {

      let memcmpFilters = [{ memcmp: { offset: 8 + 34, bytes: treasurer.toBase58() }}];  
      const accs = await program.account.stream.all(memcmpFilters);
    
      if (accs.length) {
        for (let acc of accs) {
          if (accounts.indexOf(acc) === -1) {
            accounts.push(acc);
          }
        }
      }
    }
  
    if (beneficiary) {
  
      let memcmpFilters = [{ memcmp: { offset: 8 + 106, bytes: beneficiary.toBase58() }}];
      const accs = await program.account.stream.all(memcmpFilters);
    
      if (accs.length) {
        for (let acc of accs) {
          if (accounts.indexOf(acc) === -1) {
            accounts.push(acc);
          }
        }
      }
    }
  }

  return accounts;
}

/**
 * Parses the event returned by the get_stream getter in the mps program.
 * @param event 
 * @param address stream address
 * @param friendly 
 * @returns Stream
 */
const parseGetStreamData = (
  eventRoot: StreamEventType,
  address: PublicKey,
  friendly: boolean = true

) => {

  const event = eventRoot.data;
  const createdOnUtcInSeconds = event.createdOnUtc ? event.createdOnUtc.toNumber() : 0;
  const startUtcInSeconds = event.startUtc.toNumber();
  const effectiveCreatedOnUtcInSeconds = createdOnUtcInSeconds > 0 ? createdOnUtcInSeconds : event.startUtc.toNumber();

  const stream = {
    id: friendly ? address.toBase58() : address,
    version: event.version,
    initialized: event.initialized,
    name: event.name,
    startUtc: !friendly ? new Date(startUtcInSeconds * 1000).toString() : new Date(startUtcInSeconds * 1000),
    treasurer: friendly ? event.treasurerAddress.toBase58() : event.treasurerAddress,
    treasury: friendly ? event.treasuryAddress.toBase58() : event.treasuryAddress,
    beneficiary: friendly ? event.beneficiaryAddress.toBase58() : event.beneficiaryAddress,
    associatedToken: friendly ? event.beneficiaryAssociatedToken.toBase58() : event.beneficiaryAssociatedToken,
    cliffVestAmount: friendly ? event.cliffVestAmountUnits.toNumber() : event.cliffVestAmountUnits,
    cliffVestPercent: friendly ? event.cliffVestPercent.toNumber() / 10_000 : event.cliffVestPercent.div(new BN(10_000)),
    allocationAssigned: friendly ? event.allocationAssignedUnits.toNumber() : event.allocationAssignedUnits,
    // allocationReserved: friendly ? event.allocationReservedUnits.toNumber() : event.allocationReservedUnits,

    secondsSinceStart: friendly 
      ? Math.max(0, event.currentBlockTime.toNumber() - event.startUtc.toNumber()) 
      : event.currentBlockTime.sub(new BN(event.startUtc)),

    estimatedDepletionDate: friendly 
      ? new Date(event.estDepletionTime.toNumber() * 1_000).toString() 
      : new Date(event.estDepletionTime.toNumber() * 1_000),
      
    rateAmount: friendly ? event.rateAmountUnits.toNumber() : event.rateAmountUnits,
    rateIntervalInSeconds: friendly ? event.rateIntervalInSeconds.toNumber() : event.rateIntervalInSeconds,
    totalWithdrawalsAmount: friendly ? event.totalWithdrawalsUnits.toNumber() : event.totalWithdrawalsUnits,
    fundsLeftInStream: friendly ? event.fundsLeftInStream.toNumber() : event.fundsLeftInStream,

    fundsSentToBeneficiary: friendly 
      ? event.fundsSentToBeneficiary.toNumber() 
      : new BN(event.fundsSentToBeneficiary),

    remainingAllocationAmount: friendly 
      ? event.beneficiaryRemainingAllocation.toNumber() 
      : event.beneficiaryRemainingAllocation,

    withdrawableAmount: friendly 
      ? event.beneficiaryWithdrawableAmount.toNumber() 
      : event.beneficiaryWithdrawableAmount,

    streamUnitsPerSecond: getStreamUnitsPerSecond(event),
    isManuallyPaused: event.isManualPause,
    status: event.status === 'Scheduled' ? 1 : (event.status === 'Running' ? 2 : 3),
    lastRetrievedBlockTime: friendly ? event.currentBlockTime.toNumber() : event.currentBlockTime,
    lastRetrievedTimeInSeconds: friendly 
      ? parseInt((Date.now() / 1_000).toString()) 
      : new BN(parseInt((Date.now() / 1_000).toString())),

    totalWithdrawals: friendly ? event.totalWithdrawalsUnits.toNumber() : event.totalWithdrawalsUnits,
    feePayedByTreasurer: event.feePayedByTreasurer,
    createdBlockTime: effectiveCreatedOnUtcInSeconds,
    createdOnUtc: !friendly ? new Date(effectiveCreatedOnUtcInSeconds * 1000).toString() : new Date(effectiveCreatedOnUtcInSeconds * 1000),
    upgradeRequired: false,
    data: event
    
  } as Stream;

  return stream;
}

const parseStreamItemData = (
  stream: any,
  address: PublicKey,
  blockTime: number, 
  friendly: boolean = true

) => {

  const nameBuffer = Buffer.from(stream.name);
  const createdOnUtcInSeconds = stream.createdOnUtc ? stream.createdOnUtc.toNumber() : 0;
  const startUtcInSeconds = getStreamStartUtcInSeconds(stream);
  const effectiveCreatedOnUticInSeconds = createdOnUtcInSeconds > 0 ? createdOnUtcInSeconds : startUtcInSeconds;
  let timeDiff = parseInt((Date.now() / 1_000).toString()) - blockTime;

  const streamInfo = {
    id: friendly ? address.toBase58() : address,
    version: stream.version,
    initialized: stream.initialized,
    name: new TextDecoder().decode(nameBuffer),
    startUtc: !friendly ? new Date(startUtcInSeconds * 1000).toString() : new Date(startUtcInSeconds * 1000),
    treasurer: friendly ? stream.treasurerAddress.toBase58() : stream.treasurerAddress,
    treasury: friendly ? stream.treasuryAddress.toBase58() : stream.treasuryAddress,
    beneficiary: friendly ? stream.beneficiaryAddress.toBase58() : stream.beneficiaryAddress,
    associatedToken: friendly ? stream.beneficiaryAssociatedToken.toBase58() : stream.beneficiaryAssociatedToken,
    cliffVestAmount: friendly ? stream.cliffVestAmountUnits.toNumber() : stream.cliffVestAmountUnits,
    cliffVestPercent: friendly ? stream.cliffVestPercent.toNumber() / 10_000 : stream.cliffVestPercent.div(new BN(10_000)),
    allocationAssigned: friendly ? stream.allocationAssignedUnits.toNumber() : stream.allocationAssignedUnits,
    // allocationReserved: friendly ? stream.allocationReservedUnits.toNumber() : stream.allocationReservedUnits,
    secondsSinceStart: friendly ? (blockTime - getStreamStartUtcInSeconds(stream)) : new BN(blockTime).sub(new BN(startUtcInSeconds * 1000)),
    estimatedDepletionDate: friendly ? getStreamEstDepletionDate(stream).toString() : getStreamEstDepletionDate(stream),
    rateAmount: friendly ? stream.rateAmountUnits.toNumber() : stream.rateAmountUnits,
    rateIntervalInSeconds: friendly ? stream.rateIntervalInSeconds.toNumber() : stream.rateIntervalInSeconds,
    totalWithdrawalsAmount: friendly ? stream.totalWithdrawalsUnits.toNumber() : stream.totalWithdrawalsUnits,
    fundsLeftInStream: friendly ? getFundsLeftInStream(stream, timeDiff) : new BN(getFundsLeftInStream(stream, timeDiff)),
    fundsSentToBeneficiary: friendly ? getFundsSentToBeneficiary(stream, timeDiff) : new BN(getFundsSentToBeneficiary(stream, timeDiff)),
    remainingAllocationAmount: friendly ? getStreamRemainingAllocation(stream) : new BN(getStreamRemainingAllocation(stream)),
    withdrawableAmount: friendly ? getStreamWithdrawableAmount(stream, timeDiff) : new BN(getStreamWithdrawableAmount(stream, timeDiff)),
    streamUnitsPerSecond: getStreamUnitsPerSecond(stream),
    isManuallyPaused: isStreamManuallyPaused(stream),
    status: getStreamStatus(stream, timeDiff),
    lastRetrievedBlockTime: friendly ? blockTime : new BN(blockTime),
    lastRetrievedTimeInSeconds: friendly ? parseInt((Date.now() / 1_000).toString()) : new BN(parseInt((Date.now() / 1_000).toString())),
    totalWithdrawals: friendly ? stream.totalWithdrawalsUnits.toNumber() : stream.totalWithdrawalsUnits,
    feePayedByTreasurer: stream.feePayedByTreasurer,
    transactionSignature: '',
    createdBlockTime: createdOnUtcInSeconds > 0 ? createdOnUtcInSeconds : startUtcInSeconds,
    createdOnUtc: !friendly ? new Date(effectiveCreatedOnUticInSeconds).toString() : new Date(effectiveCreatedOnUticInSeconds),
    upgradeRequired: false,
    data: {
      version: stream.version,
      initialized: stream.initialized,
      name: stream.name,
      startUtc: stream.startUtc,
      treasurerAddress: stream.treasurerAddress,
      rateAmountUnits: stream.rateAmountUnits,
      rateIntervalInSeconds: stream.rateIntervalInSeconds,
      cliffVestAmountUnits: stream.cliffVestAmountUnits,
      cliffVestPercent: stream.cliffVestPercent,
      beneficiaryAddress: stream.beneficiaryAddress,
      beneficiaryAssociatedToken: stream.beneficiaryAssociatedToken,
      treasuryAddress: stream.treasuryAddress,    
      allocationAssignedUnits: stream.allocationAssignedUnits,
      allocationReservedUnits: stream.allocationReservedUnits,
      totalWithdrawalsUnits: stream.totalWithdrawalsUnits,
      lastWithdrawalUnits: stream.lastWithdrawalUnits,
      lastWithdrawalSlot: stream.lastWithdrawalSlot,
      lastWithdrawalBlockTime: stream.lastWithdrawalBlockTime,
      lastManualStopWithdrawableUnitsSnap: stream.lastManualStopWithdrawableUnitsSnap, 
      lastManualStopSlot: stream.lastManualStopSlot,
      lastManualStopBlockTime: stream.lastManualStopBlockTime,
      lastManualResumeRemainingAllocationUnitsSnap: stream.lastManualResumeRemainingAllocationUnitsSnap,
      lastManualResumeSlot: stream.lastManualResumeSlot,
      lastManualResumeBlockTime: stream.lastManualResumeBlockTime,
      lastKnownTotalSecondsInPausedStatus: stream.lastKnownTotalSecondsInPausedStatus,
      lastAutoStopBlockTime: stream.lastAutoStopBlockTime,
      feePayedByTreasurer: stream.feePayedByTreasurer,
      // calculated data
      status: getStreamStatus(stream, timeDiff) === 1 ? "Scheduled" : (getStreamStatus(stream, 0) === 2 ? "Running" : "Paused"),
      isManualPause: isStreamManuallyPaused(stream),
      cliffUnits: new BN(getStreamCliffAmount(stream)),
      currentBlockTime: new BN(blockTime),
      secondsSinceStart: new BN(blockTime).sub(new BN(getStreamStartUtcInSeconds(stream))),
      estDepletionTime: new BN(parseInt((getStreamEstDepletionDate(stream).getTime() / 1_000).toString())),
      fundsLeftInStream: new BN(getFundsLeftInStream(stream, timeDiff)),
      fundsSentToBeneficiary: new BN(getFundsSentToBeneficiary(stream, timeDiff)),
      withdrawableUnitsWhilePaused: new BN(getStreamWithdrawableUnitsWhilePaused(stream)),
      nonStopEarningUnits: new BN(getStreamNonStopEarningUnits(stream, timeDiff)),
      missedUnitsWhilePaused: new BN(getStreamMissedEarningUnitsWhilePaused(stream)),
      entitledEarningsUnits: new BN(
        Math.max(0, getStreamNonStopEarningUnits(stream, timeDiff) - getStreamMissedEarningUnitsWhilePaused(stream))
      ),
      withdrawableUnitsWhileRunning: 
        new BN(
          Math.max(getStreamNonStopEarningUnits(stream, timeDiff) - getStreamMissedEarningUnitsWhilePaused(stream)) + 
          stream.totalWithdrawalsUnits.toNumber()
        ),
      beneficiaryRemainingAllocation: new BN(getStreamRemainingAllocation(stream)),
      beneficiaryWithdrawableAmount: new BN(getStreamWithdrawableAmount(stream, 0)),
      lastKnownStopBlockTime: new BN(
        Math.max(stream.lastAutoStopBlockTime.toNumber(), stream.lastManualStopBlockTime.toNumber())
      )
    },
    
  } as Stream;

  return streamInfo;
}

let idl_legacy_after_1645224519: any = null;
let idl_legacy_before_1645224519: any = null;
const idlPaths: string[] = [
  './msp_idl_001',
  './msp_idl_002',
  './msp_idl_003',
]
const idls: { [fileVersion: number]: any } = {};

async function parseStreamInstructionAfter1645224519(
  ix: PartiallyDecodedInstruction,
  streamAddress: PublicKey,
  transactionSignature: string,
  transactionBlockTimeInSeconds: number,
): Promise<StreamActivityRaw | null> {

  if (!ix.programId.equals(Constants.MSP)) {
    return null;
  }

  try {
    if (!idl_legacy_after_1645224519) {
      const importedIdl = await import("./msp_idl_legacy_after_1645224519");
      idl_legacy_after_1645224519 = importedIdl.IDL;
    }
    
    const coder = new BorshInstructionCoder(idl_legacy_after_1645224519 as Idl);


    const decodedIx = coder.decode(ix.data, "base58");
    if (!decodedIx) return null;

    const ixName = decodedIx.name;
    // console.log(`ixName: ${ixName}`);
    if (['createStream', 'allocate', 'withdraw'].indexOf(ixName) === -1) return null;

    const ixAccountMetas = ix.accounts.map(pk => { return { pubkey: pk, isSigner: false, isWritable: false } });

    const formattedIx = coder.format(decodedIx, ixAccountMetas);
    // console.log(formattedIx);
    // console.table(formattedIx?.accounts.map(a => { return { name: a.name, pk: a.pubkey.toBase58() } }));

    const stream = formattedIx?.accounts.find(a => a.name === 'Stream')?.pubkey;
    if (!stream || !stream.equals(streamAddress)) {
      return null;
    }

    let blockTime = (transactionBlockTimeInSeconds as number) * 1000; // mult by 1000 to add milliseconds
    let action = decodedIx.name === 'createStream' || decodedIx.name === 'allocate' ? "deposited" : "withdrew";

    let initializer: PublicKey | undefined;
    let mint: PublicKey | undefined;
    let amountBN: BN | undefined;

    if (decodedIx.name === 'createStream') {
      initializer = formattedIx?.accounts.find(a => a.name === 'Treasurer')?.pubkey;
      mint = formattedIx?.accounts.find(a => a.name === 'Associated Token')?.pubkey;
      const parsedAmount = formattedIx?.args.find(a => a.name === 'allocationAssignedUnits')?.data;
      amountBN = parsedAmount ? new BN(parsedAmount) : undefined;
    }
    else if (decodedIx.name === 'allocate') {
      initializer = formattedIx?.accounts.find(a => a.name === 'Treasurer')?.pubkey;
      mint = formattedIx?.accounts.find(a => a.name === 'Associated Token')?.pubkey;
      const parsedAmount = formattedIx?.args.find(a => a.name === 'amount')?.data;
      amountBN = parsedAmount ? new BN(parsedAmount) : undefined;
    }
    else if (decodedIx.name === 'withdraw') {
      initializer = formattedIx?.accounts.find(a => a.name === 'Beneficiary')?.pubkey;
      mint = formattedIx?.accounts.find(a => a.name === 'Associated Token')?.pubkey;
      const parsedAmount = formattedIx?.args.find(a => a.name === 'amount')?.data;
      amountBN = parsedAmount ? new BN(parsedAmount) : undefined;
    }

    const activity: StreamActivityRaw =
    {
      signature: transactionSignature,
      initializer: initializer,
      blockTime,
      utcDate: new Date(blockTime).toUTCString(),
      action,
      // TODO: Here the 'amount' might not be accurate, we need to emit events instead
      amount: amountBN,
      mint,
    };

    return activity;

  } catch (error) {
    console.log(error);
    return null;
  }
}

async function parseStreamInstructionBefore1645224519(
  ix: PartiallyDecodedInstruction,
  streamAddress: PublicKey,
  transactionSignature: string,
  transactionBlockTimeInSeconds: number,
): Promise<StreamActivityRaw | null> {

  if (!ix.programId.equals(Constants.MSP)) {
    return null;
  }

  try {

    if (!idl_legacy_before_1645224519) {
      idl_legacy_before_1645224519 = await import("./msp_idl_legacy_before_1645224519");
    }

    const coder = new BorshInstructionCoder(idl_legacy_before_1645224519 as Idl);

    const decodedIx = coder.decode(ix.data, "base58");
    if (!decodedIx) return null;

    const ixName = decodedIx.name;
    // console.log(`ixName: ${ixName}`);
    if (['createStream', 'addFunds', 'withdraw'].indexOf(ixName) === -1) return null;

    const ixAccountMetas = ix.accounts.map(pk => { return { pubkey: pk, isSigner: false, isWritable: false } });

    const formattedIx = coder.format(decodedIx, ixAccountMetas);
    // console.log(formattedIx);
    // console.table(formattedIx?.accounts.map(a => { return { name: a.name, pk: a.pubkey.toBase58() } }));

    const stream = formattedIx?.accounts.find(a => a.name === 'Stream')?.pubkey;
    if (!stream || !stream.equals(streamAddress)) {
      return null;
    }

    let blockTime = (transactionBlockTimeInSeconds as number) * 1000; // mult by 1000 to add milliseconds
    let action = decodedIx.name === 'createStream' || decodedIx.name === 'addFunds' ? "deposited" : "withdrew";

    let initializer: PublicKey | undefined;
    let mint: PublicKey | undefined;
    let amountBN: BN | undefined;

    if (decodedIx.name === 'createStream') {
      if (ixAccountMetas.length !== 14) {
        // console.log(`this createStream instruction corresponds to an IDL that is not supported`);
        return null;
      }
      initializer = formattedIx?.accounts.find(a => a.name === 'Treasurer')?.pubkey;
      mint = formattedIx?.accounts.find(a => a.name === 'Associated Token')?.pubkey;
      const parsedAmount = formattedIx?.args.find(a => a.name === 'allocationAssignedUnits')?.data;
      amountBN = parsedAmount ? new BN(parsedAmount) : undefined;
    }
    else if (decodedIx.name === 'addFunds') {
      if (ixAccountMetas.length !== 14) {
        // console.log(`this addFunds instruction corresponds to an IDL that is not supported`);
        return null;
      }
      const allocationType = formattedIx?.args.find(a => a.name === 'allocationType')?.data;
      if (allocationType !== '1') {
        return null;
      }

      initializer = formattedIx?.accounts.find(a => a.name === 'Treasurer')?.pubkey;
      mint = formattedIx?.accounts.find(a => a.name === 'Associated Token')?.pubkey;
      const parsedAmount = formattedIx?.args.find(a => a.name === 'amount')?.data;
      amountBN = parsedAmount ? new BN(parsedAmount) : undefined;
    }
    else if (decodedIx.name === 'withdraw') {
      if (ixAccountMetas.length !== 13) {
        // console.log(`this withdraw instruction corresponds to an IDL that is not supported`);
        return null;
      }
      initializer = formattedIx?.accounts.find(a => a.name === 'Beneficiary')?.pubkey;
      mint = formattedIx?.accounts.find(a => a.name === 'Associated Token')?.pubkey;
      const parsedAmount = formattedIx?.args.find(a => a.name === 'amount')?.data;
      amountBN = parsedAmount ? new BN(parsedAmount) : undefined;
    }

    const activity: StreamActivityRaw =
    {
      signature: transactionSignature,
      initializer: initializer,
      blockTime,
      utcDate: new Date(blockTime).toUTCString(),
      action,
      // TODO: Here the 'amount' might not be accurate, we need to emit events instead
      amount: amountBN,
      mint,
    };

    return activity;

  } catch (error) {
    console.log(error);
    return null;
  }
}

async function parseVersionedStreamInstruction(
  ix: PartiallyDecodedInstruction,
  streamAddress: PublicKey,
  transactionSignature: string,
  transactionBlockTimeInSeconds: number,
  idlFileVersion: number,
): Promise<StreamActivityRaw | null> {

  if (!ix.programId.equals(Constants.MSP)) {
    return null;
  }

  if(idlFileVersion <= 0 || idlFileVersion > LATEST_IDL_FILE_VERSION){
    return null;
  }

  try {
    if (!idls[idlFileVersion]) {
      if (idlFileVersion === 1) { // TODO: to avoid this if else, find a way to do dynamic imports passign concatenated paths
        const importedIdl = await import('./msp_idl_001');
        idls[idlFileVersion] = importedIdl.IDL;
      } else if (idlFileVersion === 2) {
        const importedIdl = await import('./msp_idl_002');
        idls[idlFileVersion] = importedIdl.IDL;
      } else if (idlFileVersion === 3) {
        const importedIdl = await import('./msp_idl_003');
        idls[idlFileVersion] = importedIdl.IDL;
      }else {
        return null;
      }
    }
    
    const coder = new BorshInstructionCoder(idls[idlFileVersion] as Idl);

    const decodedIx = coder.decode(ix.data, "base58");
    if (!decodedIx) return null;

    const ixName = decodedIx.name;
    // console.log(`ixName: ${ixName}`);
    if (['createStream', 'allocate', 'withdraw'].indexOf(ixName) === -1) return null;

    const ixAccountMetas = ix.accounts.map(pk => { return { pubkey: pk, isSigner: false, isWritable: false } });

    const formattedIx = coder.format(decodedIx, ixAccountMetas);
    // console.log(formattedIx);
    // console.table(formattedIx?.accounts.map(a => { return { name: a.name, pk: a.pubkey.toBase58() } }));

    const stream = formattedIx?.accounts.find(a => a.name === 'Stream')?.pubkey;
    if (!stream || !stream.equals(streamAddress)) {
      return null;
    }

    let blockTime = (transactionBlockTimeInSeconds as number) * 1000; // mult by 1000 to add milliseconds
    let action = decodedIx.name === 'createStream' || decodedIx.name === 'allocate' ? "deposited" : "withdrew";

    let initializer: PublicKey | undefined;
    let mint: PublicKey | undefined;
    let amountBN: BN | undefined;

    if (decodedIx.name === 'createStream') {
      initializer = formattedIx?.accounts.find(a => a.name === 'Treasurer')?.pubkey;
      mint = formattedIx?.accounts.find(a => a.name === 'Associated Token')?.pubkey;
      const parsedAmount = formattedIx?.args.find(a => a.name === 'allocationAssignedUnits')?.data;
      amountBN = parsedAmount ? new BN(parsedAmount) : undefined;
    }
    else if (decodedIx.name === 'allocate') {
      initializer = formattedIx?.accounts.find(a => a.name === 'Treasurer')?.pubkey;
      mint = formattedIx?.accounts.find(a => a.name === 'Associated Token')?.pubkey;
      const parsedAmount = formattedIx?.args.find(a => a.name === 'amount')?.data;
      amountBN = parsedAmount ? new BN(parsedAmount) : undefined;
    }
    else if (decodedIx.name === 'withdraw') {
      initializer = formattedIx?.accounts.find(a => a.name === 'Beneficiary')?.pubkey;
      mint = formattedIx?.accounts.find(a => a.name === 'Associated Token')?.pubkey;
      const parsedAmount = formattedIx?.args.find(a => a.name === 'amount')?.data;
      amountBN = parsedAmount ? new BN(parsedAmount) : undefined;
    }

    const activity: StreamActivityRaw =
    {
      signature: transactionSignature,
      initializer: initializer,
      blockTime,
      utcDate: new Date(blockTime).toUTCString(),
      action,
      // TODO: Here the 'amount' might not be accurate, we need to emit events instead
      amount: amountBN,
      mint,
    };

    return activity;

  } catch (error) {
    console.log(error);
    return null;
  }
}

async function parseStreamTransactions(
  streamAddress: PublicKey,
  transactions: ParsedTransactionWithMeta[],
): Promise<StreamActivityRaw[]> {

  const parsedActivities: StreamActivityRaw[] = [];

  if (!transactions || transactions.length === 0)
    return [];

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    const signature = tx.transaction.signatures[0];

    for (let j = 0; j < tx.transaction.message.instructions.length; j++) {

      const ix = tx.transaction.message.instructions[j] as PartiallyDecodedInstruction;
      if (!ix || !ix.data) continue;

      const decodedIxData = bs58.decode(ix.data);
      const ixIdlFileVersion = decodedIxData.length >= 9 ? decodedIxData.slice(8, 9)[0] : 0;
      
      let activity: StreamActivityRaw | null = null;
      if(ixIdlFileVersion > 0 && ixIdlFileVersion <= 1){ // TODO: hardcoded
        activity = await parseVersionedStreamInstruction(ix, streamAddress, signature, tx.blockTime ?? 0, ixIdlFileVersion)
      } else if (!tx.blockTime || tx.blockTime >= 1645224519) {
        activity = await parseStreamInstructionAfter1645224519(ix, streamAddress, signature, tx.blockTime ?? 0);
      }
      else {
        activity = await parseStreamInstructionBefore1645224519(ix, streamAddress, signature, tx.blockTime ?? 0);
      }

      if(!activity) {
        continue;
      }
      parsedActivities.push(activity);
    }

  }

  return parsedActivities;
}

const parseTreasuryData = (
  treasury: any,
  address: PublicKey,
  friendly: boolean = true

) => {

  const nameBuffer = Buffer.from(treasury.name);

  const treasuryAssocatedTokenMint = friendly 
    ? (treasury.associatedTokenAddress as PublicKey).equals(PublicKey.default) ? "" : treasury.associatedTokenAddress.toBase58() 
    : treasury.associatedTokenAddress;

  const treasuryCreatedUtc = treasury.createdOnUtc.toString().length > 10 
    ? parseInt(treasury.createdOnUtc.toString().substring(0, 10)) 
    : treasury.createdOnUtc.toNumber();

  return {
    id: friendly ? address.toBase58() : address,
    version: treasury.version,
    initialized: treasury.initialized,
    name: new TextDecoder().decode(nameBuffer),
    bump: treasury.bump,
    slot: treasury.slot.toNumber(),
    labels: treasury.labels,
    mint: friendly ? treasury.mintAddress.toBase58() : treasury.mintAddress,
    autoClose: treasury.autoClose,
    createdOnUtc: friendly 
      ? new Date(treasuryCreatedUtc * 1_000).toString()
      : new Date(treasuryCreatedUtc * 1_000),

    treasuryType: treasury.treasuryType === 0 ? TreasuryType.Open : TreasuryType.Lock,
    treasurer: friendly ? treasury.treasurerAddress.toBase58() : treasury.treasurerAddress,
    associatedToken: treasuryAssocatedTokenMint,
    balance: treasury.lastKnownBalanceUnits.toNumber(),
    allocationReserved: treasury.allocationReservedUnits.toNumber(),
    allocationAssigned: treasury.allocationAssignedUnits.toNumber(),
    totalWithdrawals: treasury.totalWithdrawalsUnits.toNumber(),
    totalStreams: treasury.totalStreams.toNumber(),
    data: treasury
    
  } as Treasury;
}

const getStreamEstDepletionDate = (stream: any) => {

  if (stream.rateIntervalInSeconds == 0) {
    return new Date();
  }

  let cliffAmount = getStreamCliffAmount(stream);
  let streamableAmount = Math.max(0, stream.allocationAssignedUnits.toNumber() - cliffAmount);
  let rateAmount = stream.rateIntervalInSeconds.toNumber() === 0 
    ? 0 : stream.rateAmountUnits.toNumber() / stream.rateIntervalInSeconds.toNumber();

  let streamableSeconds = streamableAmount / rateAmount;
  let duration = streamableSeconds + stream.lastKnownTotalSecondsInPausedStatus.toNumber();
  const startUtcInSeconds = getStreamStartUtcInSeconds(stream);

  return new Date((startUtcInSeconds + duration) * 1_000);
}

const getStreamCliffAmount = (stream: any) => {

  let cliffAmount = stream.cliffVestAmountUnits.toNumber();

  if (stream.cliffVestPercent > 0) {
    cliffAmount = 
      stream.cliffVestPercent.toNumber() * 
      stream.allocationAssignedUnits.toNumber() / 
      Constants.CLIFF_PERCENT_DENOMINATOR;
  }

  return parseInt(cliffAmount.toString());
}

const getFundsLeftInStream = (stream: any, timeDiff: number = 0) => {

  let withdrawableAmount = getStreamWithdrawableAmount(stream, timeDiff);
  let fundsLeft = (
    stream.allocationAssignedUnits.toNumber() -
    stream.totalWithdrawalsUnits.toNumber() -
    withdrawableAmount
  );

  return Math.max(0, fundsLeft);
}

const getFundsSentToBeneficiary = (stream: any, timeDiff: number = 0) => {

  let withdrawableAmount = getStreamWithdrawableAmount(stream, timeDiff);
  let fundsSent = (
    stream.totalWithdrawalsUnits.toNumber() +
    withdrawableAmount
  );
  return fundsSent;
}

const getStreamRemainingAllocation = (stream: any) => {
  let remainingAlloc = stream.allocationAssignedUnits.toNumber() - stream.totalWithdrawalsUnits.toNumber();
  return Math.max(0, remainingAlloc);
}

const getStreamWithdrawableAmount = (stream: any, timeDiff: number = 0) => {

  let remainingAllocation = getStreamRemainingAllocation(stream);

  if (remainingAllocation === 0) {
    return 0;
  }

  let status = getStreamStatus(stream, timeDiff);

  // Check if SCHEDULED
  if (status === STREAM_STATUS.Schedule) {
    return 0;
  }

  // Check if PAUSED
  if (status === STREAM_STATUS.Paused) {
    let manuallyPaused = isStreamManuallyPaused(stream);
    let withdrawableWhilePausedAmount = manuallyPaused 
      ? stream.lastManualStopWithdrawableUnitsSnap.toNumber()
      : stream.allocationAssignedUnits.toNumber() - stream.totalWithdrawalsUnits.toNumber();

    return Math.max(0, withdrawableWhilePausedAmount);
  }

  // Check if RUNNING
  if (stream.rateAmountUnits.toNumber() === 0 || stream.rateIntervalInSeconds.toNumber() === 0) {
    return 0;
  }

  let streamedUnitsPerSecond = getStreamUnitsPerSecond(stream);
  let cliffAmount = getStreamCliffAmount(stream);
  let blocktime = (parseInt((Date.now() / 1_000).toString()) - timeDiff);
  let startUtcInSeconds = getStreamStartUtcInSeconds(stream);
  let timeSinceStart = (blocktime - startUtcInSeconds);
  let nonStopEarningUnits = cliffAmount + (streamedUnitsPerSecond * timeSinceStart);
  let totalSecondsPaused = stream.lastKnownTotalSecondsInPausedStatus.toNumber().length >= 10
    ? parseInt((stream.lastKnownTotalSecondsInPausedStatus.toNumber() / 1_000).toString())
    : stream.lastKnownTotalSecondsInPausedStatus.toNumber();

  let missedEarningUnitsWhilePaused = streamedUnitsPerSecond * totalSecondsPaused;
  let entitledEarnings = nonStopEarningUnits;

  if (nonStopEarningUnits >= missedEarningUnitsWhilePaused) {
    entitledEarnings = nonStopEarningUnits - missedEarningUnitsWhilePaused;
  }

  let withdrawableUnitsWhileRunning = entitledEarnings;

  if (entitledEarnings >= stream.totalWithdrawalsUnits.toNumber()) {
    withdrawableUnitsWhileRunning = entitledEarnings - stream.totalWithdrawalsUnits.toNumber();
  }

  let withdrawableAmount = Math.min(remainingAllocation, withdrawableUnitsWhileRunning);

  return Math.max(0, parseInt(withdrawableAmount.toString()));
}

const getStreamStatus = (stream: any, timeDiff: number) => {

  let now = (parseInt((Date.now() / 1_000).toString()) - timeDiff);
  const startUtcInSeconds = getStreamStartUtcInSeconds(stream);

  // Scheduled
  if (startUtcInSeconds > now) { 
    return STREAM_STATUS.Schedule;
  }

  // Manually paused
  let manuallyPaused = isStreamManuallyPaused(stream);

  if (manuallyPaused) {
    return STREAM_STATUS.Paused;
  }

  // Running or automatically paused (ran out of funds)
  let streamedUnitsPerSecond = getStreamUnitsPerSecond(stream);
  let cliffAmount = getStreamCliffAmount(stream);
  let timeSinceStart = (now - startUtcInSeconds);
  let nonStopEarningUnits = cliffAmount + (streamedUnitsPerSecond * timeSinceStart);
  let missedEarningUnitsWhilePaused = streamedUnitsPerSecond * stream.lastKnownTotalSecondsInPausedStatus.toNumber();
  let entitledEarnings = nonStopEarningUnits;

  if (nonStopEarningUnits >= missedEarningUnitsWhilePaused) {
    entitledEarnings = nonStopEarningUnits - missedEarningUnitsWhilePaused;
  }

  // Running
  if (stream.allocationAssignedUnits.toNumber() > entitledEarnings) {
    return STREAM_STATUS.Running;
  }

  // Automatically paused (ran out of funds)
  return STREAM_STATUS.Paused;
}

const isStreamManuallyPaused = (stream: any) => {
  if (stream.lastManualStopBlockTime.toNumber() === 0) {
    return false;
  }
  return stream.lastManualStopBlockTime.toNumber() > stream.lastManualResumeBlockTime.toNumber();
}

const getStreamUnitsPerSecond = (stream: any) => {
  if (stream.rateIntervalInSeconds.toNumber() === 0) {
    return 0;
  }
  return stream.rateAmountUnits.toNumber() / (stream.rateIntervalInSeconds.toNumber());
}

const getStreamStartUtcInSeconds = (stream: any) => {
  let startUtcFixed = 0;
  if (stream.startUtc.toString().length > 10) {
    startUtcFixed = parseInt(stream.startUtc.toString().substr(0, 10));
    return startUtcFixed;
  }
  if (stream.startUtcInSeconds && stream.startUtcInSeconds.toNumber() > 0) {
    return stream.startUtcInSeconds.toNumber();
  }
  return stream.startUtc.toNumber();
}

const getStreamWithdrawableUnitsWhilePaused = (stream: any) => {

  let withdrawableWhilePaused = 0;
  let isManuallyPaused = isStreamManuallyPaused(stream);

  if (isManuallyPaused) {
    withdrawableWhilePaused = stream.lastManualStopWithdrawableUnitsSnap.toNumber();
  } else {
      withdrawableWhilePaused = stream.allocationAssignedUnits
        .sub(stream.totalWithdrawalsUnits).toNumber();
  }

  return Math.max(0, withdrawableWhilePaused);
}

const getStreamNonStopEarningUnits = (stream: any, timeDiff: number) => {

  let cliffUnits = getStreamCliffAmount(stream);
  let blocktime = parseInt((Date.now() / 1_000).toString()) - timeDiff;
  let secondsSinceStart = Math.max(0, blocktime - getStreamStartUtcInSeconds(stream));
  let streamUnitsSinceStarted =
    stream.rateIntervalInSeconds.toNumber() *
    secondsSinceStart /
    stream.rateAmountUnits.toNumber();

  let nonStopEarningUnits = cliffUnits + parseInt(streamUnitsSinceStarted.toString());

  return parseInt(nonStopEarningUnits.toString());
}

const getStreamMissedEarningUnitsWhilePaused = (stream: any) => {
  if (stream.rateIntervalInSeconds.toNumber() === 0) {
    return 0;
  }  

  let totalSecondsPaused = stream.lastKnownTotalSecondsInPausedStatus.toString().length > 10 
    ? parseInt(stream.startUtc.toString().substring(0, 10))
    : stream.lastKnownTotalSecondsInPausedStatus.toNumber();

  let withdrawableWhilePaused =
    stream.rateIntervalInSeconds.toNumber() *
    totalSecondsPaused /
    stream.rateAmountUnits.toNumber();

  return parseInt(withdrawableWhilePaused.toString());
}

export async function fundExistingWSolAccountInstructions(
  connection: Connection,
  owner: PublicKey,
  ownerWSolTokenAccount: PublicKey,
  payer: PublicKey,
  amountToWrapInLamports: number,
  ): Promise<[TransactionInstruction[], Keypair]>
{   
    // Allocate memory for the account
    const minimumAccountBalance = await Token.getMinBalanceRentForExemptAccount(
        connection,
    );
    const newWrapAccount = Keypair.generate();

    let wrapIxs: Array<TransactionInstruction> = 
    [
        SystemProgram.createAccount({
            fromPubkey: payer,
            newAccountPubkey: newWrapAccount.publicKey,
            lamports: minimumAccountBalance + amountToWrapInLamports,
            space: AccountLayout.span,
            programId: TOKEN_PROGRAM_ID,
        }),
        Token.createInitAccountInstruction(
            TOKEN_PROGRAM_ID,
            NATIVE_MINT,
            newWrapAccount.publicKey,
            owner
        ),
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            newWrapAccount.publicKey,
            ownerWSolTokenAccount,
            owner,
            [],
            amountToWrapInLamports
        ),
        Token.createCloseAccountInstruction(
            TOKEN_PROGRAM_ID,
            newWrapAccount.publicKey,
            payer,
            owner,
            []
        ),
    ];

    return [wrapIxs, newWrapAccount];
}

export async function createAtaCreateInstructionIfNotExists(
  ataAddress: PublicKey,
  mintAddress: PublicKey,
  ownerAccountAddress: PublicKey,
  payerAddress: PublicKey,
  connection: Connection
): Promise<TransactionInstruction | null> {
  try {
    const ata = await connection.getAccountInfo(ataAddress);
    if (!ata) {
      // console.log("ATA: %s for mint: %s was not found. Generating 'create' instruction...", ataAddress.toBase58(), mintAddress.toBase58());
      let [_, createIx] = await createAtaCreateInstruction(ataAddress, mintAddress, ownerAccountAddress, payerAddress);
      return createIx;
    }

    // console.log("ATA: %s for mint: %s already exists", ataAddress.toBase58(), mintAddress.toBase58());
    return null;
  } catch (err) {
    console.log("Unable to find associated account: %s", err);
    throw Error("Unable to find associated account");
  }
}

export async function createAtaCreateInstruction(
  ataAddress: PublicKey,
  mintAddress: PublicKey,
  ownerAccountAddress: PublicKey,
  payerAddress: PublicKey
): Promise<[PublicKey, TransactionInstruction]> {
  if (ataAddress === null) {
    ataAddress = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      mintAddress,
      ownerAccountAddress,
    );
  }

  let ataCreateInstruction = Token.createAssociatedTokenAccountInstruction(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    mintAddress,
    ataAddress,
    ownerAccountAddress,
    payerAddress,
  );
  return [ataAddress, ataCreateInstruction];
}

export async function createWrapSolInstructions(
  connection: Connection,
  wSolAmountInLamports: number,
  owner: PublicKey,
  ownerWSolTokenAccount: PublicKey,
  ownerWSolTokenAccountInfo: AccountInfo<Buffer> | null,

): Promise<[TransactionInstruction[], Keypair[]]> {

  let ixs: TransactionInstruction[] = [];
  let signers: Keypair[] = [];
  const wSolAmountInLamportsBn = new BN(wSolAmountInLamports);
  let ownerWSolAtaBalanceBn = new BN(0);

  if (ownerWSolTokenAccountInfo) {
    const ownerWSolAtaTokenAmount = (await connection.getTokenAccountBalance(ownerWSolTokenAccount)).value;
    ownerWSolAtaBalanceBn = new BN(ownerWSolAtaTokenAmount.amount);
  } else {
    let ownerFromAtaCreateInstruction = await createAtaCreateInstructionIfNotExists(
      ownerWSolTokenAccount,
      NATIVE_MINT,
      owner,
      owner,
      connection);
    if (ownerFromAtaCreateInstruction)
      ixs.push(ownerFromAtaCreateInstruction);
  }
  if (wSolAmountInLamportsBn.gt(ownerWSolAtaBalanceBn)) {
    const amountToWrapBn = wSolAmountInLamportsBn.sub(ownerWSolAtaBalanceBn);
    const [wrapIxs, newWrapAccount] = await fundExistingWSolAccountInstructions(
      connection,
      owner,
      ownerWSolTokenAccount,
      owner,
      amountToWrapBn.toNumber(),
    );
    ixs.push(...wrapIxs);
    signers.push(newWrapAccount);
  }

  return [ixs, signers];
}

// export async function createWrappedSolTokenAccountInstructions(
//   connection: Connection,
//   amountToWrapInLamports: number,
//   owner: PublicKey,
//   ownerWSolTokenAccount: PublicKey,
// ): Promise<[TransactionInstruction[], Keypair]> {

//   // REF: https://github.com/solana-labs/solana-program-library/blob/3eccf25ece1c373a117fc9f6e6cbeb2216d86f03/token/ts/src/instructions/syncNative.ts#L28
//   const wrapIxs = [
//     Token.createAssociatedTokenAccountInstruction(
//         payer.publicKey,
//         associatedToken,
//         owner,
//         NATIVE_MINT,
//         programId,
//         ASSOCIATED_TOKEN_PROGRAM_ID
//     ),
//     SystemProgram.transfer({
//         fromPubkey: payer.publicKey,
//         toPubkey: associatedToken,
//         lamports: amount,
//     }),
//     createSyncNativeInstruction(associatedToken, programId)
//   ];

//   return [wrapIxs, newWSolAccount];
// }

export function sleep(ms: number) {
  console.log("Sleeping for", ms / 1000, "seconds");
  return new Promise((resolve) => setTimeout(resolve, ms));
}
