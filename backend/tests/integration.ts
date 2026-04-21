/**
 * Integration tests for the Arcadia backend API.
 *
 * These tests mock the Solana client so they run without a validator.
 * They test the full HTTP API layer and SQLite logic end-to-end.
 *
 * To test against a real local validator:
 *   1. Run `anchor test --skip-build` in ~/SolanaContract
 *   2. Set RPC_URL=http://127.0.0.1:8899 in .env
 *   3. Remove the solana stubs below and run against the real program
 */

import { expect } from 'chai';
import * as sinon from 'sinon';
import request from 'supertest';
import * as path from 'path';
import Database from 'better-sqlite3';

// ── Setup in-memory DB before importing app ───────────────────────────────────

// Override DB path to in-memory for tests — Solana calls are stubbed out
process.env.DB_PATH = ':memory:';
process.env.ADMIN_SECRET = 'test-secret';
process.env.RPC_URL = 'http://127.0.0.1:8899';
// Use the local Solana keypair — stubs prevent any real network calls
process.env.WALLET_KEYPAIR_PATH = `${process.env.HOME}/.config/solana/id.json`;

import * as fs from 'fs';

// ── Stubs for Solana calls ────────────────────────────────────────────────────

import * as solanaModule from '../src/solana';
import * as walletModule from '../src/wallet';

let solanaStubs: sinon.SinonStub[] = [];

before(() => {
  solanaStubs = [
    sinon.stub(solanaModule, 'createRound').resolves('fake-tx-sig-create'),
    sinon.stub(solanaModule, 'commitScore').resolves('fake-tx-sig-commit'),
    sinon.stub(solanaModule, 'closeRound').resolves('fake-tx-sig-close'),
    sinon.stub(solanaModule, 'revealScore').resolves('fake-tx-sig-reveal'),
    sinon.stub(solanaModule, 'finaliseRound').resolves('fake-tx-sig-finalise'),
    sinon.stub(solanaModule, 'refundPlayer').resolves('fake-tx-sig-refund'),
    sinon.stub(walletModule, 'buildEnterRoundTx').resolves('base64encodedtransaction=='),
  ];
});

after(() => {
  solanaStubs.forEach(s => s.restore());
});

// ── Import app after stubs are set up ────────────────────────────────────────

import { app } from '../src/server';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Arcadia Backend API', () => {

  // ── POST /api/rounds ────────────────────────────────────────────────────────

  describe('POST /api/rounds — create round', () => {
    it('rejects without admin secret', async () => {
      const res = await request(app)
        .post('/api/rounds')
        .send({ entryFeeLamports: 100_000_000, durationSeconds: 300 });
      expect(res.status).to.equal(401);
    });

    it('creates a round with valid params', async () => {
      const res = await request(app)
        .post('/api/rounds')
        .set('x-admin-secret', 'test-secret')
        .send({ entryFeeLamports: 100_000_000, durationSeconds: 300 });

      expect(res.status).to.equal(201);
      expect(res.body.roundId).to.be.a('number');
      expect(res.body.entryFeeLamports).to.equal(100_000_000);
      expect(res.body.txSignature).to.equal('fake-tx-sig-create');
    });

    it('rejects zero entry fee', async () => {
      const res = await request(app)
        .post('/api/rounds')
        .set('x-admin-secret', 'test-secret')
        .send({ entryFeeLamports: 0, durationSeconds: 300 });
      expect(res.status).to.equal(400);
    });

    it('rejects zero duration', async () => {
      const res = await request(app)
        .post('/api/rounds')
        .set('x-admin-secret', 'test-secret')
        .send({ entryFeeLamports: 100_000_000, durationSeconds: 0 });
      expect(res.status).to.equal(400);
    });
  });

  // ── GET /api/rounds ─────────────────────────────────────────────────────────

  describe('GET /api/rounds — list active rounds', () => {
    it('returns a list of rounds', async () => {
      const res = await request(app).get('/api/rounds');
      expect(res.status).to.equal(200);
      expect(res.body).to.be.an('array');
      expect(res.body.length).to.be.greaterThan(0);
    });

    it('rounds have expected fields', async () => {
      const res = await request(app).get('/api/rounds');
      const round = res.body[0];
      expect(round).to.have.property('roundId');
      expect(round).to.have.property('status');
      expect(round).to.have.property('entryFee');
      expect(round).to.have.property('entryFeeSol');
      expect(round).to.have.property('timeRemainingSeconds');
    });
  });

  // ── GET /api/rounds/:roundId ─────────────────────────────────────────────────

  describe('GET /api/rounds/:roundId — get round details', () => {
    let roundId: number;

    before(async () => {
      const res = await request(app)
        .post('/api/rounds')
        .set('x-admin-secret', 'test-secret')
        .send({ entryFeeLamports: 50_000_000, durationSeconds: 600 });
      roundId = res.body.roundId;
    });

    it('returns round details', async () => {
      const res = await request(app).get(`/api/rounds/${roundId}`);
      expect(res.status).to.equal(200);
      expect(res.body.roundId).to.equal(roundId);
      expect(res.body.entryFee).to.equal(50_000_000);
    });

    it('returns 404 for non-existent round', async () => {
      const res = await request(app).get('/api/rounds/99999999');
      expect(res.status).to.equal(404);
    });
  });

  // ── GET /api/rounds/:roundId/status ──────────────────────────────────────────

  describe('GET /api/rounds/:roundId/status — countdown timer', () => {
    let roundId: number;

    before(async () => {
      const res = await request(app)
        .post('/api/rounds')
        .set('x-admin-secret', 'test-secret')
        .send({ entryFeeLamports: 10_000_000, durationSeconds: 120 });
      roundId = res.body.roundId;
    });

    it('returns status with countdown', async () => {
      const res = await request(app).get(`/api/rounds/${roundId}/status`);
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('countdown');
      expect(res.body.countdown).to.have.property('roundEnds');
      expect(res.body.countdown.roundEnds).to.be.greaterThan(0);
    });
  });

  // ── POST /api/rounds/:roundId/join ────────────────────────────────────────────

  describe('POST /api/rounds/:roundId/join — build enter_round tx', () => {
    let roundId: number;
    const playerWallet = 'So11111111111111111111111111111111111111112';

    before(async () => {
      const res = await request(app)
        .post('/api/rounds')
        .set('x-admin-secret', 'test-secret')
        .send({ entryFeeLamports: 100_000_000, durationSeconds: 3600 });
      roundId = res.body.roundId;
    });

    it('returns an unsigned transaction', async () => {
      const res = await request(app)
        .post(`/api/rounds/${roundId}/join`)
        .send({ wallet: playerWallet });

      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('transaction');
      expect(res.body.transaction).to.be.a('string');
      expect(res.body.entryFeeLamports).to.equal(100_000_000);
    });

    it('rejects without wallet', async () => {
      const res = await request(app)
        .post(`/api/rounds/${roundId}/join`)
        .send({});
      expect(res.status).to.equal(400);
    });

    it('rejects join on non-existent round', async () => {
      const res = await request(app)
        .post('/api/rounds/99999999/join')
        .send({ wallet: playerWallet });
      expect(res.status).to.equal(404);
    });
  });

  // ── POST /api/rounds/:roundId/submit-score ────────────────────────────────────

  describe('POST /api/rounds/:roundId/submit-score — commit score', () => {
    let roundId: number;
    const playerWallet = 'So11111111111111111111111111111111111111112';

    before(async () => {
      const res = await request(app)
        .post('/api/rounds')
        .set('x-admin-secret', 'test-secret')
        .send({ entryFeeLamports: 100_000_000, durationSeconds: 3600 });
      roundId = res.body.roundId;
    });

    it('accepts a valid score submission', async () => {
      const res = await request(app)
        .post(`/api/rounds/${roundId}/submit-score`)
        .send({ wallet: playerWallet, score: 12345 });

      expect(res.status).to.equal(200);
      expect(res.body.success).to.be.true;
      expect(res.body.txSignature).to.equal('fake-tx-sig-commit');
    });

    it('rejects duplicate score submission', async () => {
      const res = await request(app)
        .post(`/api/rounds/${roundId}/submit-score`)
        .send({ wallet: playerWallet, score: 99999 });
      expect(res.status).to.equal(409);
    });

    it('rejects score above MAX_SCORE', async () => {
      const otherWallet = 'So11111111111111111111111111111111111111113';
      const res = await request(app)
        .post(`/api/rounds/${roundId}/submit-score`)
        .send({ wallet: otherWallet, score: 99_999_999 });
      expect(res.status).to.equal(400);
    });

    it('rejects negative score', async () => {
      const otherWallet = 'So11111111111111111111111111111111111111114';
      const res = await request(app)
        .post(`/api/rounds/${roundId}/submit-score`)
        .send({ wallet: otherWallet, score: -1 });
      expect(res.status).to.equal(400);
    });

    it('rejects missing score', async () => {
      const otherWallet = 'So11111111111111111111111111111111111111115';
      const res = await request(app)
        .post(`/api/rounds/${roundId}/submit-score`)
        .send({ wallet: otherWallet });
      expect(res.status).to.equal(400);
    });
  });

  // ── GET /api/rounds/:roundId/leaderboard ─────────────────────────────────────

  describe('GET /api/rounds/:roundId/leaderboard — leaderboard', () => {
    let roundId: number;
    const wallets = [
      'So11111111111111111111111111111111111111112',
      'So11111111111111111111111111111111111111113',
      'So11111111111111111111111111111111111111114',
    ];

    before(async () => {
      const res = await request(app)
        .post('/api/rounds')
        .set('x-admin-secret', 'test-secret')
        .send({ entryFeeLamports: 100_000_000, durationSeconds: 3600 });
      roundId = res.body.roundId;

      // Submit scores for 3 players
      await request(app).post(`/api/rounds/${roundId}/submit-score`).send({ wallet: wallets[0], score: 150 });
      await request(app).post(`/api/rounds/${roundId}/submit-score`).send({ wallet: wallets[1], score: 420 });
      await request(app).post(`/api/rounds/${roundId}/submit-score`).send({ wallet: wallets[2], score: 310 });
    });

    it('hides scores during open round — shows player count only', async () => {
      const res = await request(app).get(`/api/rounds/${roundId}/leaderboard`);
      expect(res.status).to.equal(200);
      expect(res.body.scoresRevealed).to.be.false;
      expect(res.body.leaderboard).to.be.null;
      expect(res.body.playerCount).to.equal(3);
      expect(res.body.hint).to.include('3rd place');
    });
  });

  // ── Full flow test ────────────────────────────────────────────────────────────

  describe('Full round lifecycle flow', () => {
    it('create → join → submit → leaderboard works end-to-end', async () => {
      // 1. Create round
      const createRes = await request(app)
        .post('/api/rounds')
        .set('x-admin-secret', 'test-secret')
        .send({ entryFeeLamports: 100_000_000, durationSeconds: 300 });
      expect(createRes.status).to.equal(201);
      const roundId = createRes.body.roundId;

      // 2. Build join tx for player
      const joinRes = await request(app)
        .post(`/api/rounds/${roundId}/join`)
        .send({ wallet: 'So11111111111111111111111111111111111111112' });
      expect(joinRes.status).to.equal(200);
      expect(joinRes.body.transaction).to.be.a('string');

      // 3. Submit score
      const scoreRes = await request(app)
        .post(`/api/rounds/${roundId}/submit-score`)
        .send({ wallet: 'So11111111111111111111111111111111111111116', score: 500 });
      expect(scoreRes.status).to.equal(200);

      // 4. Check status
      const statusRes = await request(app).get(`/api/rounds/${roundId}/status`);
      expect(statusRes.status).to.equal(200);
      expect(statusRes.body.phase).to.equal('open');

      // 5. Leaderboard shows player count but hides scores
      const lbRes = await request(app).get(`/api/rounds/${roundId}/leaderboard`);
      expect(lbRes.status).to.equal(200);
      expect(lbRes.body.scoresRevealed).to.be.false;
    });
  });
});
