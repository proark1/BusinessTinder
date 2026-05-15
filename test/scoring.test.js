import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreProfile, rankProfiles, diversify } from '../backend/src/scoring.js';

const me = {
  userType: 'founder',
  lookingFor: ['cofounder'],
  industries: ['AI', 'FinTech'],
  skills: ['Product'],
  stage: 'mvp',
  location: 'Berlin',
  remoteOk: true,
};

test('scoreProfile returns 0 for missing inputs', () => {
  assert.equal(scoreProfile(null, null).score, 0);
  assert.equal(scoreProfile(me, null).score, 0);
});

test('shared industries boost score', () => {
  const them = { ...me, userType: 'cofounder_search' };
  const noOverlap = { ...them, industries: ['Climate'] };
  const overlap = { ...them, industries: ['AI', 'FinTech'] };
  assert.ok(scoreProfile(me, overlap).score > scoreProfile(me, noOverlap).score);
});

test('complementary skills boost score', () => {
  const baseline = { userType: 'cofounder_search', industries: [], skills: [], stage: 'mvp', location: 'X', lookingFor: [] };
  const helpful = { ...baseline, skills: ['Engineering', 'Sales'] };
  assert.ok(scoreProfile(me, helpful).score > scoreProfile(me, baseline).score);
  assert.ok(scoreProfile(me, helpful).reasons.some((r) => r.includes("Skills you're looking for")));
});

test('founder ↔ co-founder pairing adds bonus', () => {
  const cofounder = { userType: 'cofounder_search', industries: [], skills: [], stage: 'mvp', location: '', lookingFor: [] };
  const operator = { ...cofounder, userType: 'operator' };
  assert.ok(scoreProfile(me, cofounder).score > scoreProfile(me, operator).score);
  assert.ok(scoreProfile(me, cofounder).reasons.some((r) => r.includes('co-founder')));
});

test('same city adds bonus over different city', () => {
  const same = { userType: 'cofounder_search', industries: [], skills: [], stage: 'mvp', location: 'Berlin', lookingFor: [] };
  const diff = { ...same, location: 'NYC' };
  assert.ok(scoreProfile(me, same).score > scoreProfile(me, diff).score);
});

test('rankProfiles returns descending by score', () => {
  const profiles = [
    { userType: 'operator', industries: [], skills: [], stage: 'idea', location: 'X', lookingFor: [] },
    { userType: 'cofounder_search', industries: ['AI', 'FinTech'], skills: ['Engineering'], stage: 'mvp', location: 'Berlin', lookingFor: [] },
  ];
  const ranked = rankProfiles(me, profiles);
  assert.equal(ranked[0].score >= ranked[1].score, true);
});

test('diversify breaks 3-in-a-row of same type', () => {
  const items = [
    { profile: { userType: 'founder' }, score: 90 },
    { profile: { userType: 'founder' }, score: 89 },
    { profile: { userType: 'founder' }, score: 88 },
    { profile: { userType: 'investor' }, score: 50 },
  ];
  const out = diversify(items);
  const firstThree = out.slice(0, 3).map((x) => x.profile.userType);
  assert.notDeepEqual(firstThree, ['founder', 'founder', 'founder']);
});

test('score is clamped at 100', () => {
  const them = {
    userType: 'cofounder_search',
    industries: me.industries,
    skills: ['Engineering', 'Design', 'Product', 'Sales', 'Marketing'],
    stage: me.stage,
    location: me.location,
    remoteOk: true,
    lastActiveAt: new Date(),
    lookingFor: [],
  };
  assert.ok(scoreProfile(me, them).score <= 100);
});
