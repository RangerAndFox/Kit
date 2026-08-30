'use server'

export async function approveAction(actionId: string) {
  void actionId
  throw new Error('Actions are unavailable until a durable action store is connected.')
}

export async function dismissAction(actionId: string) {
  void actionId
  throw new Error('Actions are unavailable until a durable action store is connected.')
}
