import { describe, expect, it } from 'vitest'
import {
  buildFrameIoProjectAccessRequest,
  resolveFreelancerFrameIoRole,
} from './frameio'

describe('Frame.io freelancer project access', () => {
  it('defaults freelancers to editor access', () => {
    expect(resolveFreelancerFrameIoRole()).toBe('editor')
  })

  it('accepts only Frame.io v4 project roles', () => {
    expect(resolveFreelancerFrameIoRole('commenter')).toBe('commenter')
    expect(() => resolveFreelancerFrameIoRole('team_member')).toThrow(
      /Invalid FRAMEIO_FREELANCER_PROJECT_ROLE/,
    )
  })

  it('builds an idempotent project-permission request with editor access', () => {
    const request = buildFrameIoProjectAccessRequest({
      accountId: 'account-1',
      projectId: 'project-1',
      userId: 'user-1',
      role: 'editor',
      headers: { Authorization: 'Bearer test' },
    })

    expect(request.url).toBe(
      'https://api.frame.io/v4/accounts/account-1/projects/project-1/users/user-1',
    )
    expect(request.init.method).toBe('PATCH')
    expect(request.init.headers).toEqual({ Authorization: 'Bearer test' })
    expect(request.init.body).toBe(JSON.stringify({ data: { role: 'editor' } }))
  })
})
