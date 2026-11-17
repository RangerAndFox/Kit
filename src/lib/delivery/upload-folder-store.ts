import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '../supabase/admin'
import type { FolderContext } from './upload-folder'

export async function folderRpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (createAdminClient() as unknown as SupabaseClient).rpc(name, args)
  if (error) throw new Error('Folder review checkpoint unavailable. Nothing new was approved.')
  return data as T
}
export async function prepareUploadFolder(project: string, path: string): Promise<FolderContext> {
  const context = await folderRpc<FolderContext | null>('prepare_frame_upload_folder', { p_project: project, p_folder: path })
  if (!context) throw new Error('No pending folder request. Nothing new was approved.')
  return context
}
