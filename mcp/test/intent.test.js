// The simulated Alexa's rules: requests to study are never taken as answers, and answers stay answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intentOf } from '../sim/intent.js';

const kind = (s, pending = true) => intentOf(s, { pending }).kind;
const topic = (s, pending = true) => intentOf(s, { pending }).topic;

test('asking for a quiz in your own words starts one, even mid-quiz', () => {
  for (const s of ['Test my knowledge', 'Can you test me on my notes?', 'Start a quiz', 'Ask me a question', 'Help me revise',
    'I want to practise pricing', 'Quiz me about pricing', 'Alexa, quiz me', "Let's do a quiz about Security", 'next question', 'test']) {
    assert.equal(kind(s), 'quiz', s);
  }
});

test('the topic of a quiz request is picked out, without filler words', () => {
  assert.equal(topic('Quiz me on economics'), 'economics');
  assert.equal(topic('Quiz me about pricing'), 'pricing');
  assert.equal(topic('Quiz me on my pricing notes, please'), 'pricing');
  assert.equal(topic('I want to practise pricing'), 'pricing');
  assert.equal(topic("Let's do a quiz about Security"), 'security');
  assert.equal(topic('Can you test me on my notes?'), null);
  assert.equal(topic('Test my knowledge'), null);
});

test('answers stay answers', () => {
  for (const s of ['Spot', 'pay as you go', 'on-demand', 'IaaS', 'cloud-based?', "I don't know", 'the provider', 'Skimming']) {
    assert.equal(kind(s), 'answer', s);
  }
  assert.equal(kind('review'), 'answer', 'a lone study word mid-quiz is an answer');
  assert.equal(kind('review', false), 'quiz', 'and a request when nothing is asked');
});

test('hints, progress, repeating and stopping', () => {
  assert.equal(kind('Give me a hint'), 'hint');
  assert.equal(kind('How am I doing?'), 'progress');
  assert.equal(kind('What should I review?'), 'progress');
  assert.equal(kind('Repeat the question'), 'repeat');
  assert.equal(kind("That's enough"), 'stop');
});
