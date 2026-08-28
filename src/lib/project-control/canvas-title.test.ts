import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { projectCanvasTitle } from './canvas-title'

describe('projectCanvasTitle', () => {
  it('uses only the project ID and canonical compact suffix', () => {
    assert.equal(projectCanvasTitle('2637', 'overview'), '2637_Overview')
    assert.equal(projectCanvasTitle('2637', 'schedule'), '2637_Schedule')
    assert.equal(projectCanvasTitle('2637', 'reference'), '2637_Reference')
    assert.equal(projectCanvasTitle('2637', 'notesAndFeedback'), '2637_NotesAndFeedback')
  })

  it('preserves alphanumeric project IDs and trims whitespace', () => {
    assert.equal(projectCanvasTitle(' 2630A ', 'overview'), '2630A_Overview')
  })
})
