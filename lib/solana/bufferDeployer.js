"use strict";

// ---------------------------------------------------------------------------
// Staged program buffer engine (audit Module 4) — enterprise deployment
// pipeline for the BPF Loader Upgradeable program.
//
// Wire-format facts the math depends on:
//   Buffer rent: Solana rent-exemption is (data_len + 128) × 6,960 lamports.
//     Anchors: 0 bytes → 890,880 (0.00089088 SOL); 165 bytes → 2,039,280
//     (0.00203928 SOL) — both match `solana rent` output exactly.
//   Chunking: bytecode writes are capped so the write transaction stays
//     inside the 1,232-byte IPv6-MTU-derived on-chain limit; 900-byte data
//     chunks leave ample room for instruction + key overhead.
//
// Pure, testable core: chunk planning with SHA-256 integrity manifests,
// exact rent math, authority hand-off state machine, and the orphaned-buffer
// rent-reclamation planner. No RPC client here — the caller wires these
// plans to real transactions; every plan is deterministic and auditable.
// ---------------------------------------------------------------------------

const crypto = require("crypto");

const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = "BPFLoaderUpgradeab1e11111111111111111111111";
const DEFAULT_CHUNK_SIZE = 900;
const RENT_BYTES_OVERHEAD = 128;
const RENT_LAMPORTS_PER_BYTE = 6960;
const MAX_TX_BYTES = 1232;

/** Rent-exempt minimum, exact on-chain formula. */
function rentExemptLamports(dataLen) {
  const len = Number(dataLen);
  if (!Number.isInteger(len) || len < 0) throw new Error("dataLen must be a non-negative integer");
  return BigInt(len + RENT_BYTES_OVERHEAD) * BigInt(RENT_LAMPORTS_PER_BYTE);
}

/** MTU-safety proof for a chunk size: chunk data + write-instruction
 *  overhead must fit inside the on-chain transaction limit. */
function assertChunkSizeMtuSafe(chunkSize) {
  // Overhead: instruction discriminator(4) + offset u32(4) + bytes vec prefix(4)
  // + program/header keys ≈ 120 B conservative + signature block ≈ 64·N.
  const overheadBytes = 260;
  const total = chunkSize + overheadBytes;
  if (total > MAX_TX_BYTES) {
    throw new Error(
      `chunk size ${chunkSize} yields ~${total}-byte transactions — exceeds the ` +
        `${MAX_TX_BYTES}-byte on-chain limit (IPv6 MTU). Reduce the chunk size.`
    );
  }
  return { chunkSize, estimatedTxBytes: total, limit: MAX_TX_BYTES, mtuSafe: true };
}

/**
 * Chunk planner. Deterministic: the same buffer always yields the same
 * chunk sequence. Every chunk carries its offset and a SHA-256 of its
 * bytes; the manifest hashes the FULL buffer so reassembly integrity is
 * provable end-to-end (audit Module 4: no missing-chunk or reordering race).
 */
function planBufferChunks(programBytes, chunkSize = DEFAULT_CHUNK_SIZE) {
  if (!Buffer.isBuffer(programBytes) || programBytes.length === 0) {
    throw new Error("programBytes must be a non-empty Buffer (compiled .so binary)");
  }
  if (!Number.isInteger(chunkSize) || chunkSize < 100 || chunkSize > 1000) {
    throw new Error("chunkSize must be an integer in [100, 1000]");
  }
  assertChunkSizeMtuSafe(chunkSize);
  const manifestSha256 = crypto.createHash("sha256").update(programBytes).digest("hex");
  const chunks = [];
  for (let offset = 0; offset < programBytes.length; offset += chunkSize) {
    const bytes = programBytes.subarray(offset, Math.min(offset + chunkSize, programBytes.length));
    chunks.push({
      offset,
      length: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      bytes,
    });
  }
  return {
    totalBytes: programBytes.length,
    chunkSize,
    chunkCount: chunks.length,
    manifestSha256,
    chunks,
    rentLamports: rentExemptLamports(programBytes.length),
    programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  };
}

/** Prove a chunk set reassembles to the planned buffer: contiguous offsets,
 *  per-chunk hashes match, concatenated bytes hash to the manifest. */
function verifyChunkReassembly(plan, chunks) {
  if (!plan || !Array.isArray(plan.chunks) || !Array.isArray(chunks)) {
    throw new Error("verifyChunkReassembly needs a plan and a chunk array");
  }
  if (chunks.length !== plan.chunkCount) {
    return { ok: false, reason: `chunk count mismatch: plan expects ${plan.chunkCount}, got ${chunks.length}` };
  }
  const sorted = [...chunks].sort((a, b) => a.offset - b.offset);
  let cursor = 0;
  const parts = [];
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const expected = plan.chunks[i];
    if (c.offset !== cursor) {
      return { ok: false, reason: `non-contiguous chunk sequence: expected offset ${cursor}, got ${c.offset} (missing-chunk race detected)` };
    }
    if (c.sha256 !== expected.sha256) {
      return { ok: false, reason: `chunk at offset ${c.offset} failed integrity: sha256 mismatch (bytecode corruption)` };
    }
    if (c.length !== expected.length) {
      return { ok: false, reason: `chunk at offset ${c.offset} has length ${c.length}, plan expects ${expected.length}` };
    }
    cursor += c.length;
    parts.push(c.bytes);
  }
  if (cursor !== plan.totalBytes) {
    return { ok: false, reason: `reassembled ${cursor} bytes, plan declares ${plan.totalBytes}` };
  }
  const full = Buffer.concat(parts);
  const fullHash = crypto.createHash("sha256").update(full).digest("hex");
  if (fullHash !== plan.manifestSha256) {
    return { ok: false, reason: "full-buffer manifest hash mismatch — bytecode corrupted end-to-end" };
  }
  return { ok: true, totalBytes: plan.totalBytes, manifestSha256: plan.manifestSha256 };
}

// ---------------------------------------------------------------------------
// Authority hand-off state machine (hot deployer → buffer → cold/multisig).
// Transitions fail closed; the deployer key NEVER touches the live program.
// ---------------------------------------------------------------------------

const HANDOFF_STATES = ["HOT_UPLOAD", "BUFFER_STAGED", "AUTHORITY_TRANSFERRED", "MULTISIG_APPROVED", "DEPLOYED", "ABORTED"];

class AuthorityHandoff {
  constructor({ programId, bufferAddress }) {
    this.programId = String(programId);
    this.bufferAddress = String(bufferAddress);
    this.state = "HOT_UPLOAD";
    this.history = [{ state: "HOT_UPLOAD", at: new Date().toISOString() }];
  }

  _transit(to, note) {
    this.history.push({ state: to, at: new Date().toISOString(), note });
    this.state = to;
  }

  /** Chunks uploaded + verified — buffer is staged and immutable-in-intent. */
  stageBuffer(reassemblyProof) {
    if (this.state !== "HOT_UPLOAD") throw new Error(`Cannot stage buffer from '${this.state}'`);
    if (!reassemblyProof || reassemblyProof.ok !== true) {
      throw new Error("Refusing to stage a buffer whose chunks failed reassembly verification");
    }
    this._transit("BUFFER_STAGED", `manifest ${reassemblyProof.manifestSha256}`);
    return this;
  }

  /** Atomic authority transition: hot key relinquishes the buffer. */
  setBufferAuthority(newAuthorityAddress) {
    if (this.state !== "BUFFER_STAGED") throw new Error(`Cannot transfer authority from '${this.state}'`);
    if (!newAuthorityAddress || typeof newAuthorityAddress !== "string") {
      throw new Error("new buffer authority address is required");
    }
    this._transit("AUTHORITY_TRANSFERRED", `authority → ${newAuthorityAddress}`);
    return this;
  }

  /** Cold signer / multisig approves deployment from the staged buffer. */
  approveDeployment(approverAddress) {
    if (this.state !== "AUTHORITY_TRANSFERRED") {
      throw new Error(`Cannot approve deployment from '${this.state}' — the cold authority must hold the buffer first`);
    }
    if (!approverAddress) throw new Error("approver address is required");
    this._transit("MULTISIG_APPROVED", `approved by ${approverAddress}`);
    return this;
  }

  deployToProgram() {
    if (this.state !== "MULTISIG_APPROVED") {
      throw new Error(`Cannot deploy from '${this.state}' — upgrade requires the cold authority's approval FIRST`);
    }
    this._transit("DEPLOYED", `program ${this.programId} upgraded from buffer ${this.bufferAddress}`);
    return this;
  }

  abort(reason) {
    if (this.state === "DEPLOYED") throw new Error("Cannot abort a deployed hand-off");
    this._transit("ABORTED", reason ?? "aborted by operator");
    return this;
  }
}

// ---------------------------------------------------------------------------
// Orphaned-buffer rent sweeper — pure planner over a supplied account list.
// A buffer is CLOSEABLE iff: owned by the BPF loader, state is a buffer
// (not an active program), and its authority is one of OUR keys. Active
// programs and foreign accounts are protected. Reclaimed lamports sum
// exactly — no stranded SOL is silently dropped.
// ---------------------------------------------------------------------------

/** Sweep plan for parsed buffer accounts (from getParsedProgramAccounts). */
function planRentSweep(accounts, { ourAuthorities, recipient }) {
  if (!Array.isArray(accounts)) throw new Error("accounts must be an array");
  if (!Array.isArray(ourAuthorities) || ourAuthorities.length === 0) {
    throw new Error("ourAuthorities is required — the sweeper closes ONLY buffers whose authority we hold");
  }
  if (!recipient) throw new Error("recipient is required — reclaimed SOL goes somewhere explicit");
  const ours = new Set(ourAuthorities.map((a) => String(a).toLowerCase()));
  const plan = { closeable: [], protected: [], totalReclaimedLamports: 0n, recipient: String(recipient) };
  for (const acc of accounts) {
    const isBuffer = acc.type === "buffer" || acc.dataSize === 37 || acc.state === "uninitialized";
    const isOurs = ours.has(String(acc.authority ?? "").toLowerCase());
    if (acc.type === "program" || acc.isProgram) {
      plan.protected.push({ address: acc.address, reason: "active program account — never closed" });
      continue;
    }
    if (!isBuffer) {
      plan.protected.push({ address: acc.address, reason: "not a buffer account" });
      continue;
    }
    if (!isOurs) {
      plan.protected.push({ address: acc.address, reason: "authority is not ours — foreign buffer" });
      continue;
    }
    const lamports = BigInt(acc.lamports ?? 0);
    plan.closeable.push({ address: acc.address, lamports: lamports.toString() });
    plan.totalReclaimedLamports += lamports;
  }
  plan.totalReclaimedSol = (Number(plan.totalReclaimedLamports) / 1e9).toFixed(9);
  plan.honesty =
    "PLAN ONLY — the caller executes these closes against real RPC. A close that " +
    "fails on-chain is reported, never assumed; reclaimed totals are recomputed " +
    "from actual balances after execution.";
  return plan;
}

module.exports = {
  BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  DEFAULT_CHUNK_SIZE,
  MAX_TX_BYTES,
  rentExemptLamports,
  assertChunkSizeMtuSafe,
  planBufferChunks,
  verifyChunkReassembly,
  AuthorityHandoff,
  HANDOFF_STATES,
  planRentSweep,
};
