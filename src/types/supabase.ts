export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      accessibility_jobs: {
        Row: {
          created_at: string | null
          elevenlabs_cost_cents: number | null
          error_message: string | null
          id: string
          max_retries: number
          narration_script_json: Json | null
          output_dv_mp3_path: string | null
          output_folder_path: string | null
          output_srt_path: string | null
          output_ttml_path: string | null
          output_txt_path: string | null
          pause_windows_json: Json | null
          progress_message: string | null
          progress_percent: number
          retry_count: number
          slack_channel: string | null
          slack_message_ts: string | null
          slack_notified_status: string | null
          slack_thread_ts: string | null
          source_dropbox_id: string
          source_duration_seconds: number | null
          source_size_bytes: number | null
          source_video_path: string
          status: string
          updated_at: string | null
          vision_cost_cents: number | null
          whisper_cost_cents: number | null
          whisper_segments_json: Json | null
        }
        Insert: {
          created_at?: string | null
          elevenlabs_cost_cents?: number | null
          error_message?: string | null
          id?: string
          max_retries?: number
          narration_script_json?: Json | null
          output_dv_mp3_path?: string | null
          output_folder_path?: string | null
          output_srt_path?: string | null
          output_ttml_path?: string | null
          output_txt_path?: string | null
          pause_windows_json?: Json | null
          progress_message?: string | null
          progress_percent?: number
          retry_count?: number
          slack_channel?: string | null
          slack_message_ts?: string | null
          slack_notified_status?: string | null
          slack_thread_ts?: string | null
          source_dropbox_id: string
          source_duration_seconds?: number | null
          source_size_bytes?: number | null
          source_video_path: string
          status?: string
          updated_at?: string | null
          vision_cost_cents?: number | null
          whisper_cost_cents?: number | null
          whisper_segments_json?: Json | null
        }
        Update: {
          created_at?: string | null
          elevenlabs_cost_cents?: number | null
          error_message?: string | null
          id?: string
          max_retries?: number
          narration_script_json?: Json | null
          output_dv_mp3_path?: string | null
          output_folder_path?: string | null
          output_srt_path?: string | null
          output_ttml_path?: string | null
          output_txt_path?: string | null
          pause_windows_json?: Json | null
          progress_message?: string | null
          progress_percent?: number
          retry_count?: number
          slack_channel?: string | null
          slack_message_ts?: string | null
          slack_notified_status?: string | null
          slack_thread_ts?: string | null
          source_dropbox_id?: string
          source_duration_seconds?: number | null
          source_size_bytes?: number | null
          source_video_path?: string
          status?: string
          updated_at?: string | null
          vision_cost_cents?: number | null
          whisper_cost_cents?: number | null
          whisper_segments_json?: Json | null
        }
        Relationships: []
      }
      action_breakdowns: {
        Row: {
          approved_by: string | null
          assignments: Json
          call_date: string | null
          call_summary: string | null
          created_at: string | null
          distributed_at: string | null
          draft_client_email: string | null
          id: string
          project_id: string
          scope_concerns: Json | null
          status: string | null
          transcript_source: string | null
          workspace_id: string
        }
        Insert: {
          approved_by?: string | null
          assignments: Json
          call_date?: string | null
          call_summary?: string | null
          created_at?: string | null
          distributed_at?: string | null
          draft_client_email?: string | null
          id?: string
          project_id: string
          scope_concerns?: Json | null
          status?: string | null
          transcript_source?: string | null
          workspace_id: string
        }
        Update: {
          approved_by?: string | null
          assignments?: Json
          call_date?: string | null
          call_summary?: string | null
          created_at?: string | null
          distributed_at?: string | null
          draft_client_email?: string | null
          id?: string
          project_id?: string
          scope_concerns?: Json | null
          status?: string | null
          transcript_source?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "action_breakdowns_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "action_breakdowns_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "action_breakdowns_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_runs: {
        Row: {
          actions_created: string[] | null
          completed_at: string | null
          duration_ms: number | null
          error: string | null
          id: string
          projects_processed: string[] | null
          run_type: string
          started_at: string | null
          status: string | null
          tokens_used: number | null
          trigger: string | null
          workspace_id: string
        }
        Insert: {
          actions_created?: string[] | null
          completed_at?: string | null
          duration_ms?: number | null
          error?: string | null
          id?: string
          projects_processed?: string[] | null
          run_type: string
          started_at?: string | null
          status?: string | null
          tokens_used?: number | null
          trigger?: string | null
          workspace_id: string
        }
        Update: {
          actions_created?: string[] | null
          completed_at?: string | null
          duration_ms?: number | null
          error?: string | null
          id?: string
          projects_processed?: string[] | null
          run_type?: string
          started_at?: string | null
          status?: string | null
          tokens_used?: number | null
          trigger?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_runs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      archive_activity: {
        Row: {
          action: string
          created_at: string | null
          details: Json | null
          file_name: string | null
          id: string
          project_id: string | null
          workspace_id: string
        }
        Insert: {
          action: string
          created_at?: string | null
          details?: Json | null
          file_name?: string | null
          id?: string
          project_id?: string | null
          workspace_id: string
        }
        Update: {
          action?: string
          created_at?: string | null
          details?: Json | null
          file_name?: string | null
          id?: string
          project_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "archive_activity_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "archive_activity_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      artifacts: {
        Row: {
          artifact_type: string
          created_at: string
          created_by: string
          data: Json
          id: string
          project_id: string
          version: number
        }
        Insert: {
          artifact_type: string
          created_at?: string
          created_by: string
          data: Json
          id?: string
          project_id: string
          version?: number
        }
        Update: {
          artifact_type?: string
          created_at?: string
          created_by?: string
          data?: Json
          id?: string
          project_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "artifacts_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      autonomy_settings: {
        Row: {
          action_type: string
          autonomy_level: string
          created_at: string | null
          id: string
          project_id: string | null
          set_by: string | null
          workspace_id: string
        }
        Insert: {
          action_type: string
          autonomy_level: string
          created_at?: string | null
          id?: string
          project_id?: string | null
          set_by?: string | null
          workspace_id: string
        }
        Update: {
          action_type?: string
          autonomy_level?: string
          created_at?: string | null
          id?: string
          project_id?: string | null
          set_by?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "autonomy_settings_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "autonomy_settings_set_by_fkey"
            columns: ["set_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "autonomy_settings_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      bible_versions: {
        Row: {
          changelog: string
          created_at: string
          id: string
          markdown: string
          project_id: string
          sections: Json
          updated_by: string
          version: number
        }
        Insert: {
          changelog: string
          created_at?: string
          id?: string
          markdown: string
          project_id: string
          sections?: Json
          updated_by: string
          version: number
        }
        Update: {
          changelog?: string
          created_at?: string
          id?: string
          markdown?: string
          project_id?: string
          sections?: Json
          updated_by?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "bible_versions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      brain_revisions: {
        Row: {
          author: string | null
          brain_id: string
          created_at: string | null
          diff: string | null
          id: number
          operation: string | null
          provenance: Json | null
          revision: number
          section: string | null
        }
        Insert: {
          author?: string | null
          brain_id: string
          created_at?: string | null
          diff?: string | null
          id?: number
          operation?: string | null
          provenance?: Json | null
          revision: number
          section?: string | null
        }
        Update: {
          author?: string | null
          brain_id?: string
          created_at?: string | null
          diff?: string | null
          id?: number
          operation?: string | null
          provenance?: Json | null
          revision?: number
          section?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "brain_revisions_brain_id_fkey"
            columns: ["brain_id"]
            isOneToOne: false
            referencedRelation: "brains"
            referencedColumns: ["id"]
          },
        ]
      }
      brain_scavenger_candidates: {
        Row: {
          applied_section: string | null
          approval_dm_ts: string | null
          approver: string | null
          brain_id: string
          created_at: string | null
          decided_at: string | null
          dm_sent_at: string | null
          id: number
          similarity: number | null
          source_doc_id: string | null
          source_ref: string | null
          status: string
          summary: string | null
          why_relevant: string | null
          workspace_id: string
        }
        Insert: {
          applied_section?: string | null
          approval_dm_ts?: string | null
          approver?: string | null
          brain_id: string
          created_at?: string | null
          decided_at?: string | null
          dm_sent_at?: string | null
          id?: number
          similarity?: number | null
          source_doc_id?: string | null
          source_ref?: string | null
          status?: string
          summary?: string | null
          why_relevant?: string | null
          workspace_id: string
        }
        Update: {
          applied_section?: string | null
          approval_dm_ts?: string | null
          approver?: string | null
          brain_id?: string
          created_at?: string | null
          decided_at?: string | null
          dm_sent_at?: string | null
          id?: number
          similarity?: number | null
          source_doc_id?: string | null
          source_ref?: string | null
          status?: string
          summary?: string | null
          why_relevant?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "brain_scavenger_candidates_brain_id_fkey"
            columns: ["brain_id"]
            isOneToOne: false
            referencedRelation: "brains"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "brain_scavenger_candidates_source_doc_id_fkey"
            columns: ["source_doc_id"]
            isOneToOne: false
            referencedRelation: "project_documents"
            referencedColumns: ["id"]
          },
        ]
      }
      brains: {
        Row: {
          autonomy: string
          canvas_id: string | null
          canvas_url: string | null
          created_at: string | null
          id: string
          markdown: string
          project_code: string | null
          project_id: string | null
          revision: number
          scope: string
          slack_channel: string | null
          updated_at: string | null
          visibility: string
          workspace_id: string
        }
        Insert: {
          autonomy?: string
          canvas_id?: string | null
          canvas_url?: string | null
          created_at?: string | null
          id: string
          markdown?: string
          project_code?: string | null
          project_id?: string | null
          revision?: number
          scope: string
          slack_channel?: string | null
          updated_at?: string | null
          visibility?: string
          workspace_id: string
        }
        Update: {
          autonomy?: string
          canvas_id?: string | null
          canvas_url?: string | null
          created_at?: string | null
          id?: string
          markdown?: string
          project_code?: string | null
          project_id?: string | null
          revision?: number
          scope?: string
          slack_channel?: string | null
          updated_at?: string | null
          visibility?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "brains_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      call_classifications: {
        Row: {
          call_type: string
          classified_by: string | null
          confidence: number | null
          created_at: string | null
          document_id: string | null
          id: string
          key_topics: string[] | null
          project_id: string | null
          reasoning: string | null
          workflow_triggered: string | null
          workspace_id: string
        }
        Insert: {
          call_type: string
          classified_by?: string | null
          confidence?: number | null
          created_at?: string | null
          document_id?: string | null
          id?: string
          key_topics?: string[] | null
          project_id?: string | null
          reasoning?: string | null
          workflow_triggered?: string | null
          workspace_id: string
        }
        Update: {
          call_type?: string
          classified_by?: string | null
          confidence?: number | null
          created_at?: string | null
          document_id?: string | null
          id?: string
          key_topics?: string[] | null
          project_id?: string | null
          reasoning?: string | null
          workflow_triggered?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_classifications_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "project_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_classifications_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_classifications_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      call_transcripts: {
        Row: {
          created_at: string
          duration_seconds: number | null
          end_time: string | null
          external_file_id: string | null
          external_recording_id: string | null
          id: string
          ingest_error: string | null
          ingest_status: string
          participants: Json | null
          project_id: string | null
          project_match_attempted_at: string | null
          source: string
          start_time: string | null
          transcript: string | null
          updated_at: string
          workspace_id: string | null
        }
        Insert: {
          created_at?: string
          duration_seconds?: number | null
          end_time?: string | null
          external_file_id?: string | null
          external_recording_id?: string | null
          id?: string
          ingest_error?: string | null
          ingest_status?: string
          participants?: Json | null
          project_id?: string | null
          project_match_attempted_at?: string | null
          source?: string
          start_time?: string | null
          transcript?: string | null
          updated_at?: string
          workspace_id?: string | null
        }
        Update: {
          created_at?: string
          duration_seconds?: number | null
          end_time?: string | null
          external_file_id?: string | null
          external_recording_id?: string | null
          id?: string
          ingest_error?: string | null
          ingest_status?: string
          participants?: Json | null
          project_id?: string | null
          project_match_attempted_at?: string | null
          source?: string
          start_time?: string | null
          transcript?: string | null
          updated_at?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "call_transcripts_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_transcripts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      character_sheets: {
        Row: {
          brief: string
          character_name: string
          consistency_anchors: Json
          created_at: string
          design_sheets: Json
          id: string
          project_id: string
          role: string
          status: string
          updated_at: string
        }
        Insert: {
          brief: string
          character_name: string
          consistency_anchors?: Json
          created_at?: string
          design_sheets?: Json
          id?: string
          project_id: string
          role: string
          status?: string
          updated_at?: string
        }
        Update: {
          brief?: string
          character_name?: string
          consistency_anchors?: Json
          created_at?: string
          design_sheets?: Json
          id?: string
          project_id?: string
          role?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "character_sheets_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      client_profiles: {
        Row: {
          avg_response_time_hours: number | null
          avg_revision_rounds: number | null
          client_name: string
          created_at: string | null
          harvest_client_id: number | null
          health_score: number | null
          health_trend: string | null
          id: string
          notes: string | null
          payment_reliability: string | null
          primary_contacts: Json | null
          project_count: number | null
          scope_creep_tendency: string | null
          total_lifetime_revenue: number | null
          updated_at: string | null
          workspace_id: string
        }
        Insert: {
          avg_response_time_hours?: number | null
          avg_revision_rounds?: number | null
          client_name: string
          created_at?: string | null
          harvest_client_id?: number | null
          health_score?: number | null
          health_trend?: string | null
          id?: string
          notes?: string | null
          payment_reliability?: string | null
          primary_contacts?: Json | null
          project_count?: number | null
          scope_creep_tendency?: string | null
          total_lifetime_revenue?: number | null
          updated_at?: string | null
          workspace_id: string
        }
        Update: {
          avg_response_time_hours?: number | null
          avg_revision_rounds?: number | null
          client_name?: string
          created_at?: string | null
          harvest_client_id?: number | null
          health_score?: number | null
          health_trend?: string | null
          id?: string
          notes?: string | null
          payment_reliability?: string | null
          primary_contacts?: Json | null
          project_count?: number | null
          scope_creep_tendency?: string | null
          total_lifetime_revenue?: number | null
          updated_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_profiles_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_state: {
        Row: {
          key: string
          state: Json
          updated_at: string
        }
        Insert: {
          key: string
          state: Json
          updated_at?: string
        }
        Update: {
          key?: string
          state?: Json
          updated_at?: string
        }
        Relationships: []
      }
      daily_hours_checkins: {
        Row: {
          candidate_projects: Json | null
          check_in_date: string
          created_at: string
          dm_channel_id: string | null
          dm_ts: string | null
          error_message: string | null
          harvest_entry_ids: Json | null
          id: string
          logged_at: string | null
          nudged_at: string | null
          origin: string
          parsed_entries: Json | null
          reply_ts: string | null
          slack_user_id: string
          staff_id: string
          status: string
          updated_at: string
        }
        Insert: {
          candidate_projects?: Json | null
          check_in_date: string
          created_at?: string
          dm_channel_id?: string | null
          dm_ts?: string | null
          error_message?: string | null
          harvest_entry_ids?: Json | null
          id?: string
          logged_at?: string | null
          nudged_at?: string | null
          origin?: string
          parsed_entries?: Json | null
          reply_ts?: string | null
          slack_user_id: string
          staff_id: string
          status: string
          updated_at?: string
        }
        Update: {
          candidate_projects?: Json | null
          check_in_date?: string
          created_at?: string
          dm_channel_id?: string | null
          dm_ts?: string | null
          error_message?: string | null
          harvest_entry_ids?: Json | null
          id?: string
          logged_at?: string | null
          nudged_at?: string | null
          origin?: string
          parsed_entries?: Json | null
          reply_ts?: string | null
          slack_user_id?: string
          staff_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_hours_checkins_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_task_cards: {
        Row: {
          approved_by: string | null
          approved_content: string | null
          card_date: string
          created_at: string | null
          distributed_at: string | null
          eod_checkin_response: Json | null
          eod_checkin_sent: boolean | null
          generated_content: string
          id: string
          projects: Json
          status: string | null
          team_member_id: string
          workspace_id: string
        }
        Insert: {
          approved_by?: string | null
          approved_content?: string | null
          card_date: string
          created_at?: string | null
          distributed_at?: string | null
          eod_checkin_response?: Json | null
          eod_checkin_sent?: boolean | null
          generated_content: string
          id?: string
          projects: Json
          status?: string | null
          team_member_id: string
          workspace_id: string
        }
        Update: {
          approved_by?: string | null
          approved_content?: string | null
          card_date?: string
          created_at?: string | null
          distributed_at?: string | null
          eod_checkin_response?: Json | null
          eod_checkin_sent?: boolean | null
          generated_content?: string
          id?: string
          projects?: Json
          status?: string | null
          team_member_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_task_cards_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_task_cards_team_member_id_fkey"
            columns: ["team_member_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_task_cards_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      deliverables: {
        Row: {
          created_at: string | null
          delivered_at: string | null
          delivery_url: string | null
          description: string | null
          due_date: string | null
          id: string
          name: string
          project_id: string
          status: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string | null
          delivered_at?: string | null
          delivery_url?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          name: string
          project_id: string
          status?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string | null
          delivered_at?: string | null
          delivery_url?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          name?: string
          project_id?: string
          status?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "deliverables_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliverables_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      delivery_profiles: {
        Row: {
          archived: boolean
          audio_bit_depth: number
          audio_bitrate: string | null
          audio_channels: Json
          audio_codec: string
          audio_sample_rate: number
          color_space: string | null
          container: string
          created_at: string
          created_by: string
          description: string | null
          frame_rate: string
          frame_rate_mode: string
          head_pad_seconds: number | null
          id: string
          loudness_standard: string | null
          lufs_lra: number | null
          lufs_target: number | null
          name: string
          naming_example: string | null
          naming_template: string | null
          notes: string | null
          pixel_format: string | null
          pixel_map_url: string | null
          qc_checklist: Json
          resolution_h: number
          resolution_w: number
          scan_mode: string
          tail_pad_seconds: number | null
          true_peak_limit: number | null
          updated_at: string
          video_bitrate: string | null
          video_codec: string
          video_filters: string | null
        }
        Insert: {
          archived?: boolean
          audio_bit_depth?: number
          audio_bitrate?: string | null
          audio_channels?: Json
          audio_codec?: string
          audio_sample_rate?: number
          color_space?: string | null
          container?: string
          created_at?: string
          created_by: string
          description?: string | null
          frame_rate?: string
          frame_rate_mode?: string
          head_pad_seconds?: number | null
          id?: string
          loudness_standard?: string | null
          lufs_lra?: number | null
          lufs_target?: number | null
          name: string
          naming_example?: string | null
          naming_template?: string | null
          notes?: string | null
          pixel_format?: string | null
          pixel_map_url?: string | null
          qc_checklist?: Json
          resolution_h?: number
          resolution_w?: number
          scan_mode?: string
          tail_pad_seconds?: number | null
          true_peak_limit?: number | null
          updated_at?: string
          video_bitrate?: string | null
          video_codec?: string
          video_filters?: string | null
        }
        Update: {
          archived?: boolean
          audio_bit_depth?: number
          audio_bitrate?: string | null
          audio_channels?: Json
          audio_codec?: string
          audio_sample_rate?: number
          color_space?: string | null
          container?: string
          created_at?: string
          created_by?: string
          description?: string | null
          frame_rate?: string
          frame_rate_mode?: string
          head_pad_seconds?: number | null
          id?: string
          loudness_standard?: string | null
          lufs_lra?: number | null
          lufs_target?: number | null
          name?: string
          naming_example?: string | null
          naming_template?: string | null
          notes?: string | null
          pixel_format?: string | null
          pixel_map_url?: string | null
          qc_checklist?: Json
          resolution_h?: number
          resolution_w?: number
          scan_mode?: string
          tail_pad_seconds?: number | null
          true_peak_limit?: number | null
          updated_at?: string
          video_bitrate?: string | null
          video_codec?: string
          video_filters?: string | null
        }
        Relationships: []
      }
      delivery_spec_intake: {
        Row: {
          channel_id: string
          consumed_at: string | null
          created_at: string
          id: string
          output_dir: string | null
          sources: Json
          status: string
          thread_ts: string
        }
        Insert: {
          channel_id: string
          consumed_at?: string | null
          created_at?: string
          id?: string
          output_dir?: string | null
          sources?: Json
          status?: string
          thread_ts: string
        }
        Update: {
          channel_id?: string
          consumed_at?: string | null
          created_at?: string
          id?: string
          output_dir?: string | null
          sources?: Json
          status?: string
          thread_ts?: string
        }
        Relationships: []
      }
      delivery_specs: {
        Row: {
          audio_format: string
          checklist: Json
          codec: string
          color_space: string
          created_at: string
          delivered_at: string | null
          frame_rate: number
          id: string
          platform_requirements: Json
          project_id: string
          resolution: string
          status: string
        }
        Insert: {
          audio_format: string
          checklist?: Json
          codec: string
          color_space: string
          created_at?: string
          delivered_at?: string | null
          frame_rate: number
          id?: string
          platform_requirements?: Json
          project_id: string
          resolution: string
          status?: string
        }
        Update: {
          audio_format?: string
          checklist?: Json
          codec?: string
          color_space?: string
          created_at?: string
          delivered_at?: string | null
          frame_rate?: number
          id?: string
          platform_requirements?: Json
          project_id?: string
          resolution?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "delivery_specs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      dropbox_state: {
        Row: {
          cursor: string | null
          id: string
          updated_at: string
        }
        Insert: {
          cursor?: string | null
          id?: string
          updated_at?: string
        }
        Update: {
          cursor?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      edit_decisions: {
        Row: {
          created_at: string
          duration: number
          editorial_note: string | null
          id: string
          order_index: number
          project_id: string
          shot_ref: string
          time_in: number
          time_out: number
          transition: string
        }
        Insert: {
          created_at?: string
          duration: number
          editorial_note?: string | null
          id?: string
          order_index: number
          project_id: string
          shot_ref: string
          time_in: number
          time_out: number
          transition?: string
        }
        Update: {
          created_at?: string
          duration?: number
          editorial_note?: string | null
          id?: string
          order_index?: number
          project_id?: string
          shot_ref?: string
          time_in?: number
          time_out?: number
          transition?: string
        }
        Relationships: [
          {
            foreignKeyName: "edit_decisions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      farm_status: {
        Row: {
          canary_passed: boolean | null
          canary_time_seconds: number | null
          check_time: string | null
          diagnostics: Json | null
          id: string
          jobs_active: number | null
          jobs_failed: number | null
          node_details: Json | null
          nodes_offline: number | null
          nodes_online: number | null
          nodes_rendering: number | null
          overall_health: string | null
          summary: string | null
          workspace_id: string
        }
        Insert: {
          canary_passed?: boolean | null
          canary_time_seconds?: number | null
          check_time?: string | null
          diagnostics?: Json | null
          id?: string
          jobs_active?: number | null
          jobs_failed?: number | null
          node_details?: Json | null
          nodes_offline?: number | null
          nodes_online?: number | null
          nodes_rendering?: number | null
          overall_health?: string | null
          summary?: string | null
          workspace_id: string
        }
        Update: {
          canary_passed?: boolean | null
          canary_time_seconds?: number | null
          check_time?: string | null
          diagnostics?: Json | null
          id?: string
          jobs_active?: number | null
          jobs_failed?: number | null
          node_details?: Json | null
          nodes_offline?: number | null
          nodes_online?: number | null
          nodes_rendering?: number | null
          overall_health?: string | null
          summary?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "farm_status_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      feedback_items: {
        Row: {
          assigned_to: string | null
          client_contact: string | null
          content: string
          created_at: string | null
          id: string
          project_id: string | null
          received_at: string
          related_asset: string | null
          resolved_at: string | null
          revision_round: number | null
          sentiment: string | null
          source: string
          source_id: string | null
          source_url: string | null
          status: string | null
          summary: string | null
          workspace_id: string
        }
        Insert: {
          assigned_to?: string | null
          client_contact?: string | null
          content: string
          created_at?: string | null
          id?: string
          project_id?: string | null
          received_at: string
          related_asset?: string | null
          resolved_at?: string | null
          revision_round?: number | null
          sentiment?: string | null
          source: string
          source_id?: string | null
          source_url?: string | null
          status?: string | null
          summary?: string | null
          workspace_id: string
        }
        Update: {
          assigned_to?: string | null
          client_contact?: string | null
          content?: string
          created_at?: string | null
          id?: string
          project_id?: string | null
          received_at?: string
          related_asset?: string | null
          resolved_at?: string | null
          revision_round?: number | null
          sentiment?: string | null
          source?: string
          source_id?: string | null
          source_url?: string | null
          status?: string | null
          summary?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "feedback_items_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feedback_items_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feedback_items_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      financial_entries: {
        Row: {
          amount: number | null
          due_date: string | null
          entry_type: string | null
          external_id: string | null
          id: string
          project_id: string | null
          status: string | null
          synced_at: string | null
          vendor_or_client: string | null
          workspace_id: string
        }
        Insert: {
          amount?: number | null
          due_date?: string | null
          entry_type?: string | null
          external_id?: string | null
          id?: string
          project_id?: string | null
          status?: string | null
          synced_at?: string | null
          vendor_or_client?: string | null
          workspace_id: string
        }
        Update: {
          amount?: number | null
          due_date?: string | null
          entry_type?: string | null
          external_id?: string | null
          id?: string
          project_id?: string | null
          status?: string | null
          synced_at?: string | null
          vendor_or_client?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "financial_entries_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "financial_entries_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      founder_content_access: {
        Row: {
          accessed_at: string | null
          accessed_by: string
          document_id: string | null
          id: string
          query: string | null
          workspace_id: string
        }
        Insert: {
          accessed_at?: string | null
          accessed_by: string
          document_id?: string | null
          id?: string
          query?: string | null
          workspace_id: string
        }
        Update: {
          accessed_at?: string | null
          accessed_by?: string
          document_id?: string | null
          id?: string
          query?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "founder_content_access_accessed_by_fkey"
            columns: ["accessed_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "founder_content_access_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "project_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "founder_content_access_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      frameio_token_state: {
        Row: {
          id: string
          refresh_token: string | null
          updated_at: string
        }
        Insert: {
          id?: string
          refresh_token?: string | null
          updated_at?: string
        }
        Update: {
          id?: string
          refresh_token?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      freelancer_onboardings: {
        Row: {
          artist_email: string
          artist_legal_name: string | null
          artist_name: string | null
          artist_slack_user_id: string | null
          artist_staff_id: string | null
          created_at: string
          dropbox_error: string | null
          dropbox_status: string | null
          frameio_error: string | null
          frameio_status: string | null
          harvest_error: string | null
          harvest_status: string | null
          id: string
          nda_error: string | null
          nda_sent_at: string | null
          nda_status: string | null
          project_id: string | null
          requested_by_slack_user_id: string
          slack_error: string | null
          slack_status: string | null
          updated_at: string
          welcome_dm_error: string | null
          welcome_dm_status: string | null
        }
        Insert: {
          artist_email: string
          artist_legal_name?: string | null
          artist_name?: string | null
          artist_slack_user_id?: string | null
          artist_staff_id?: string | null
          created_at?: string
          dropbox_error?: string | null
          dropbox_status?: string | null
          frameio_error?: string | null
          frameio_status?: string | null
          harvest_error?: string | null
          harvest_status?: string | null
          id?: string
          nda_error?: string | null
          nda_sent_at?: string | null
          nda_status?: string | null
          project_id?: string | null
          requested_by_slack_user_id: string
          slack_error?: string | null
          slack_status?: string | null
          updated_at?: string
          welcome_dm_error?: string | null
          welcome_dm_status?: string | null
        }
        Update: {
          artist_email?: string
          artist_legal_name?: string | null
          artist_name?: string | null
          artist_slack_user_id?: string | null
          artist_staff_id?: string | null
          created_at?: string
          dropbox_error?: string | null
          dropbox_status?: string | null
          frameio_error?: string | null
          frameio_status?: string | null
          harvest_error?: string | null
          harvest_status?: string | null
          id?: string
          nda_error?: string | null
          nda_sent_at?: string | null
          nda_status?: string | null
          project_id?: string | null
          requested_by_slack_user_id?: string
          slack_error?: string | null
          slack_status?: string | null
          updated_at?: string
          welcome_dm_error?: string | null
          welcome_dm_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "freelancer_onboardings_artist_staff_id_fkey"
            columns: ["artist_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freelancer_onboardings_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      freelancer_paperwork: {
        Row: {
          created_at: string
          email: string
          last_onboarding_id: string | null
          legal_name: string | null
          nda_completed_at: string | null
          nda_completed_by: string | null
          nda_sent_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          last_onboarding_id?: string | null
          legal_name?: string | null
          nda_completed_at?: string | null
          nda_completed_by?: string | null
          nda_sent_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          last_onboarding_id?: string | null
          legal_name?: string | null
          nda_completed_at?: string | null
          nda_completed_by?: string | null
          nda_sent_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      gates: {
        Row: {
          created_at: string
          gate_name: string
          gate_number: number
          id: string
          project_id: string
          requested_by: string
          resolved_at: string | null
          responded_by: string | null
          responded_via: string | null
          revision_notes: string | null
          slack_message_ts: string | null
          status: string
        }
        Insert: {
          created_at?: string
          gate_name: string
          gate_number: number
          id?: string
          project_id: string
          requested_by: string
          resolved_at?: string | null
          responded_by?: string | null
          responded_via?: string | null
          revision_notes?: string | null
          slack_message_ts?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          gate_name?: string
          gate_number?: number
          id?: string
          project_id?: string
          requested_by?: string
          resolved_at?: string | null
          responded_by?: string | null
          responded_via?: string | null
          revision_notes?: string | null
          slack_message_ts?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "gates_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      generated_documents: {
        Row: {
          created_at: string | null
          created_by: string | null
          doc_type: string
          file_url: string
          generation_params: Json | null
          id: string
          project_id: string | null
          title: string
          workspace_id: string
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          doc_type: string
          file_url: string
          generation_params?: Json | null
          id?: string
          project_id?: string | null
          title: string
          workspace_id: string
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          doc_type?: string
          file_url?: string
          generation_params?: Json | null
          id?: string
          project_id?: string | null
          title?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "generated_documents_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "generated_documents_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "generated_documents_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      generation_tasks: {
        Row: {
          agent_name: string
          attempt_number: number
          bible_section: string | null
          completed_at: string | null
          cost_usd: number
          created_at: string
          id: string
          model_id: string
          model_provider: string
          negative_prompt: string | null
          parameters: Json
          parent_task_id: string | null
          phase: number
          project_id: string
          prompt: string
          qc_decision: string | null
          qc_notes: string | null
          result_metadata: Json | null
          result_url: string | null
          status: string
          task_type: string
        }
        Insert: {
          agent_name: string
          attempt_number?: number
          bible_section?: string | null
          completed_at?: string | null
          cost_usd?: number
          created_at?: string
          id?: string
          model_id: string
          model_provider: string
          negative_prompt?: string | null
          parameters?: Json
          parent_task_id?: string | null
          phase: number
          project_id: string
          prompt: string
          qc_decision?: string | null
          qc_notes?: string | null
          result_metadata?: Json | null
          result_url?: string | null
          status?: string
          task_type: string
        }
        Update: {
          agent_name?: string
          attempt_number?: number
          bible_section?: string | null
          completed_at?: string | null
          cost_usd?: number
          created_at?: string
          id?: string
          model_id?: string
          model_provider?: string
          negative_prompt?: string | null
          parameters?: Json
          parent_task_id?: string | null
          phase?: number
          project_id?: string
          prompt?: string
          qc_decision?: string | null
          qc_notes?: string | null
          result_metadata?: Json | null
          result_url?: string | null
          status?: string
          task_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "generation_tasks_parent_task_id_fkey"
            columns: ["parent_task_id"]
            isOneToOne: false
            referencedRelation: "generation_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "generation_tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      harvest_user_map: {
        Row: {
          created_at: string
          harvest_user_id: number
          harvest_user_name: string | null
          id: string
          slack_user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          harvest_user_id: number
          harvest_user_name?: string | null
          id?: string
          slack_user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          harvest_user_id?: number
          harvest_user_name?: string | null
          id?: string
          slack_user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "harvest_user_map_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      hours_missing_alerts: {
        Row: {
          alert_channel_id: string | null
          alert_ts: string | null
          created_at: string
          id: string
          last_logged_date: string | null
          missing_dates: Json
          slack_user_id: string | null
          staff_id: string
          streak_days: number
          streak_start_date: string
        }
        Insert: {
          alert_channel_id?: string | null
          alert_ts?: string | null
          created_at?: string
          id?: string
          last_logged_date?: string | null
          missing_dates?: Json
          slack_user_id?: string | null
          staff_id: string
          streak_days: number
          streak_start_date: string
        }
        Update: {
          alert_channel_id?: string | null
          alert_ts?: string | null
          created_at?: string
          id?: string
          last_logged_date?: string | null
          missing_dates?: Json
          slack_user_id?: string | null
          staff_id?: string
          streak_days?: number
          streak_start_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "hours_missing_alerts_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      intake_messages: {
        Row: {
          attachments: Json | null
          content: string
          created_at: string
          extracted_data: Json | null
          id: string
          role: string
          session_id: string
          turn_number: number
        }
        Insert: {
          attachments?: Json | null
          content: string
          created_at?: string
          extracted_data?: Json | null
          id?: string
          role: string
          session_id: string
          turn_number: number
        }
        Update: {
          attachments?: Json | null
          content?: string
          created_at?: string
          extracted_data?: Json | null
          id?: string
          role?: string
          session_id?: string
          turn_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "intake_messages_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "intake_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      intake_sessions: {
        Row: {
          created_at: string
          id: string
          project_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          project_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          project_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "intake_sessions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      integrations: {
        Row: {
          config: Json | null
          connected_at: string | null
          connected_by: string | null
          credentials: Json
          error_message: string | null
          id: string
          last_synced_at: string | null
          scopes: string[] | null
          service: string
          status: string | null
          updated_at: string | null
          workspace_id: string
        }
        Insert: {
          config?: Json | null
          connected_at?: string | null
          connected_by?: string | null
          credentials?: Json
          error_message?: string | null
          id?: string
          last_synced_at?: string | null
          scopes?: string[] | null
          service: string
          status?: string | null
          updated_at?: string | null
          workspace_id: string
        }
        Update: {
          config?: Json | null
          connected_at?: string | null
          connected_by?: string | null
          credentials?: Json
          error_message?: string | null
          id?: string
          last_synced_at?: string | null
          scopes?: string[] | null
          service?: string
          status?: string | null
          updated_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "integrations_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "integrations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      kit_actions: {
        Row: {
          acted_at: string | null
          action_type: string
          approved_by: string | null
          body: string
          channel: string | null
          created_at: string | null
          id: string
          min_tier_to_view: string | null
          priority: string | null
          project_id: string | null
          requires_approval: boolean | null
          status: string | null
          target_audience: string[] | null
          title: string
          workspace_id: string
        }
        Insert: {
          acted_at?: string | null
          action_type: string
          approved_by?: string | null
          body: string
          channel?: string | null
          created_at?: string | null
          id?: string
          min_tier_to_view?: string | null
          priority?: string | null
          project_id?: string | null
          requires_approval?: boolean | null
          status?: string | null
          target_audience?: string[] | null
          title: string
          workspace_id: string
        }
        Update: {
          acted_at?: string | null
          action_type?: string
          approved_by?: string | null
          body?: string
          channel?: string | null
          created_at?: string | null
          id?: string
          min_tier_to_view?: string | null
          priority?: string | null
          project_id?: string | null
          requires_approval?: boolean | null
          status?: string | null
          target_audience?: string[] | null
          title?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "kit_actions_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kit_actions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kit_actions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      managed_agent_registry: {
        Row: {
          external_id: string
          key: string
          kind: string
          metadata: Json | null
          model: string | null
          registered_at: string
          version: string | null
        }
        Insert: {
          external_id: string
          key: string
          kind: string
          metadata?: Json | null
          model?: string | null
          registered_at?: string
          version?: string | null
        }
        Update: {
          external_id?: string
          key?: string
          kind?: string
          metadata?: Json | null
          model?: string | null
          registered_at?: string
          version?: string | null
        }
        Relationships: []
      }
      meeting_briefings: {
        Row: {
          attendees_json: Json | null
          briefing_md: string | null
          calendar_id: string | null
          confidence: number | null
          created_at: string | null
          error: string | null
          event_id: string
          id: string
          meeting_start_time: string | null
          meeting_title: string | null
          meeting_type: string
          notified_user_ids: Json | null
          producer_dm_ts: string | null
          project_id: string | null
          slack_channel_id: string | null
          slack_message_ts: string | null
          status: string
          updated_at: string | null
        }
        Insert: {
          attendees_json?: Json | null
          briefing_md?: string | null
          calendar_id?: string | null
          confidence?: number | null
          created_at?: string | null
          error?: string | null
          event_id: string
          id?: string
          meeting_start_time?: string | null
          meeting_title?: string | null
          meeting_type?: string
          notified_user_ids?: Json | null
          producer_dm_ts?: string | null
          project_id?: string | null
          slack_channel_id?: string | null
          slack_message_ts?: string | null
          status?: string
          updated_at?: string | null
        }
        Update: {
          attendees_json?: Json | null
          briefing_md?: string | null
          calendar_id?: string | null
          confidence?: number | null
          created_at?: string | null
          error?: string | null
          event_id?: string
          id?: string
          meeting_start_time?: string | null
          meeting_title?: string | null
          meeting_type?: string
          notified_user_ids?: Json | null
          producer_dm_ts?: string | null
          project_id?: string | null
          slack_channel_id?: string | null
          slack_message_ts?: string | null
          status?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "meeting_briefings_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      milestones: {
        Row: {
          assigned_to: string | null
          completed_at: string | null
          created_at: string | null
          dependencies: string[] | null
          description: string | null
          due_date: string
          id: string
          name: string
          owner: string | null
          phase_type: string | null
          project_id: string
          reminded_at: string | null
          status: string | null
          workspace_id: string
        }
        Insert: {
          assigned_to?: string | null
          completed_at?: string | null
          created_at?: string | null
          dependencies?: string[] | null
          description?: string | null
          due_date: string
          id?: string
          name: string
          owner?: string | null
          phase_type?: string | null
          project_id: string
          reminded_at?: string | null
          status?: string | null
          workspace_id: string
        }
        Update: {
          assigned_to?: string | null
          completed_at?: string | null
          created_at?: string | null
          dependencies?: string[] | null
          description?: string | null
          due_date?: string
          id?: string
          name?: string
          owner?: string | null
          phase_type?: string | null
          project_id?: string
          reminded_at?: string | null
          status?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "milestones_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "milestones_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "milestones_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      model_catalog: {
        Row: {
          added_by: string
          api_endpoint: string
          avoid: string[]
          benchmark_results: Json | null
          best_for: string[]
          capabilities: Json
          constraints: Json
          created_at: string
          evaluation_notes: string | null
          id: string
          last_verified: string
          name: string
          notes: string | null
          pricing: Json
          provider: string
          release_date: string | null
          status: string
          strengths: string[]
          style_compatibility: Json
          type: string
          updated_at: string
          weaknesses: string[]
        }
        Insert: {
          added_by?: string
          api_endpoint: string
          avoid?: string[]
          benchmark_results?: Json | null
          best_for?: string[]
          capabilities?: Json
          constraints?: Json
          created_at?: string
          evaluation_notes?: string | null
          id: string
          last_verified?: string
          name: string
          notes?: string | null
          pricing?: Json
          provider: string
          release_date?: string | null
          status?: string
          strengths?: string[]
          style_compatibility?: Json
          type: string
          updated_at?: string
          weaknesses?: string[]
        }
        Update: {
          added_by?: string
          api_endpoint?: string
          avoid?: string[]
          benchmark_results?: Json | null
          best_for?: string[]
          capabilities?: Json
          constraints?: Json
          created_at?: string
          evaluation_notes?: string | null
          id?: string
          last_verified?: string
          name?: string
          notes?: string | null
          pricing?: Json
          provider?: string
          release_date?: string | null
          status?: string
          strengths?: string[]
          style_compatibility?: Json
          type?: string
          updated_at?: string
          weaknesses?: string[]
        }
        Relationships: []
      }
      model_research_log: {
        Row: {
          actions_taken: Json
          findings: Json
          id: string
          models_affected: string[]
          query: string
          run_at: string
          source: string
        }
        Insert: {
          actions_taken?: Json
          findings?: Json
          id?: string
          models_affected?: string[]
          query: string
          run_at?: string
          source: string
        }
        Update: {
          actions_taken?: Json
          findings?: Json
          id?: string
          models_affected?: string[]
          query?: string
          run_at?: string
          source?: string
        }
        Relationships: []
      }
      model_scores: {
        Row: {
          agent_run_id: string
          created_at: string
          criteria: string
          id: string
          model: string
          notes: string | null
          score: number | null
        }
        Insert: {
          agent_run_id: string
          created_at?: string
          criteria: string
          id?: string
          model: string
          notes?: string | null
          score?: number | null
        }
        Update: {
          agent_run_id?: string
          created_at?: string
          criteria?: string
          id?: string
          model?: string
          notes?: string | null
          score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "model_scores_agent_run_id_fkey"
            columns: ["agent_run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      permission_requests: {
        Row: {
          context: string | null
          created_at: string | null
          id: string
          original_question: string | null
          project_id: string | null
          requested_access: string
          requester_id: string
          responded_at: string | null
          responded_by: string | null
          response_message: string | null
          status: string | null
          workspace_id: string
        }
        Insert: {
          context?: string | null
          created_at?: string | null
          id?: string
          original_question?: string | null
          project_id?: string | null
          requested_access: string
          requester_id: string
          responded_at?: string | null
          responded_by?: string | null
          response_message?: string | null
          status?: string | null
          workspace_id: string
        }
        Update: {
          context?: string | null
          created_at?: string | null
          id?: string
          original_question?: string | null
          project_id?: string | null
          requested_access?: string
          requester_id?: string
          responded_at?: string | null
          responded_by?: string | null
          response_message?: string | null
          status?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "permission_requests_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "permission_requests_requester_id_fkey"
            columns: ["requester_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "permission_requests_responded_by_fkey"
            columns: ["responded_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "permission_requests_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      pitch_log: {
        Row: {
          budget_range: string | null
          client: string
          competitors: string[] | null
          created_at: string | null
          decision_date: string | null
          id: string
          notes: string | null
          outcome: string | null
          outcome_reason: string | null
          pitch_date: string | null
          project_description: string | null
          project_type: string | null
          workspace_id: string
        }
        Insert: {
          budget_range?: string | null
          client: string
          competitors?: string[] | null
          created_at?: string | null
          decision_date?: string | null
          id?: string
          notes?: string | null
          outcome?: string | null
          outcome_reason?: string | null
          pitch_date?: string | null
          project_description?: string | null
          project_type?: string | null
          workspace_id: string
        }
        Update: {
          budget_range?: string | null
          client?: string
          competitors?: string[] | null
          created_at?: string | null
          decision_date?: string | null
          id?: string
          notes?: string | null
          outcome?: string | null
          outcome_reason?: string | null
          pitch_date?: string | null
          project_description?: string | null
          project_type?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pitch_log_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      project_access: {
        Row: {
          added_at: string | null
          can_see_financials: boolean | null
          custom_permissions: Json | null
          deliverables: string[] | null
          id: string
          project_id: string
          project_role: string | null
          removed_at: string | null
          team_member_id: string
          workspace_id: string
        }
        Insert: {
          added_at?: string | null
          can_see_financials?: boolean | null
          custom_permissions?: Json | null
          deliverables?: string[] | null
          id?: string
          project_id: string
          project_role?: string | null
          removed_at?: string | null
          team_member_id: string
          workspace_id: string
        }
        Update: {
          added_at?: string | null
          can_see_financials?: boolean | null
          custom_permissions?: Json | null
          deliverables?: string[] | null
          id?: string
          project_id?: string
          project_role?: string | null
          removed_at?: string | null
          team_member_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_access_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_access_team_member_id_fkey"
            columns: ["team_member_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_access_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      project_documents: {
        Row: {
          content: string
          created_at: string | null
          doc_type: string
          embedding: string | null
          id: string
          indexed_at: string | null
          metadata: Json | null
          project_id: string | null
          source_url: string | null
          title: string
          visibility_tier: string
          workspace_id: string
        }
        Insert: {
          content: string
          created_at?: string | null
          doc_type: string
          embedding?: string | null
          id?: string
          indexed_at?: string | null
          metadata?: Json | null
          project_id?: string | null
          source_url?: string | null
          title: string
          visibility_tier?: string
          workspace_id: string
        }
        Update: {
          content?: string
          created_at?: string | null
          doc_type?: string
          embedding?: string | null
          id?: string
          indexed_at?: string | null
          metadata?: Json | null
          project_id?: string | null
          source_url?: string | null
          title?: string
          visibility_tier?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_documents_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_documents_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      project_settings: {
        Row: {
          frameio_upload_enabled: boolean
          project_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          frameio_upload_enabled?: boolean
          project_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          frameio_upload_enabled?: boolean
          project_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_settings_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: true
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          brief_summary: string | null
          budget_alert_threshold: number | null
          budget_spent: number | null
          budget_total: number | null
          client: string
          created_at: string | null
          external_ids: Json | null
          external_links: Json | null
          financial_sheet_url: string | null
          harvest_project_id: number | null
          harvest_task_id: number | null
          id: string
          margin_target: number | null
          name: string
          project_code: string | null
          project_manager_slack_id: string | null
          project_ops_id: string | null
          project_type: string | null
          provisioning_status: Json | null
          revision_rounds_budgeted: number | null
          revision_rounds_used: number | null
          slack_channel_id: string | null
          sow_summary: string | null
          start_date: string | null
          status: string | null
          target_delivery: string | null
          updated_at: string | null
          workspace_id: string
        }
        Insert: {
          brief_summary?: string | null
          budget_alert_threshold?: number | null
          budget_spent?: number | null
          budget_total?: number | null
          client: string
          created_at?: string | null
          external_ids?: Json | null
          external_links?: Json | null
          financial_sheet_url?: string | null
          harvest_project_id?: number | null
          harvest_task_id?: number | null
          id?: string
          margin_target?: number | null
          name: string
          project_code?: string | null
          project_manager_slack_id?: string | null
          project_ops_id?: string | null
          project_type?: string | null
          provisioning_status?: Json | null
          revision_rounds_budgeted?: number | null
          revision_rounds_used?: number | null
          slack_channel_id?: string | null
          sow_summary?: string | null
          start_date?: string | null
          status?: string | null
          target_delivery?: string | null
          updated_at?: string | null
          workspace_id: string
        }
        Update: {
          brief_summary?: string | null
          budget_alert_threshold?: number | null
          budget_spent?: number | null
          budget_total?: number | null
          client?: string
          created_at?: string | null
          external_ids?: Json | null
          external_links?: Json | null
          financial_sheet_url?: string | null
          harvest_project_id?: number | null
          harvest_task_id?: number | null
          id?: string
          margin_target?: number | null
          name?: string
          project_code?: string | null
          project_manager_slack_id?: string | null
          project_ops_id?: string | null
          project_type?: string | null
          provisioning_status?: Json | null
          revision_rounds_budgeted?: number | null
          revision_rounds_used?: number | null
          slack_channel_id?: string | null
          sow_summary?: string | null
          start_date?: string | null
          status?: string | null
          target_delivery?: string | null
          updated_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "projects_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      render_jobs: {
        Row: {
          ae_comp: string | null
          ae_is_movie: boolean
          ae_output_dir: string | null
          ae_output_module_template: string | null
          ae_output_pattern: string | null
          ae_project_path: string | null
          ae_render_settings_template: string | null
          ae_rqindex: number | null
          aerender_command: string | null
          chunk_count: number | null
          chunk_index: number | null
          claimed_at: string | null
          claimed_by: string | null
          completed_at: string | null
          created_at: string
          deadline_jobs: Json | null
          delivery_profile_id: string | null
          duration_seconds: number | null
          error_message: string | null
          ffmpeg_command: string | null
          frame_end: number | null
          frame_rate: string | null
          frame_start: number | null
          id: string
          job_type: string
          max_retries: number
          naming_fields: Json | null
          output_filename: string | null
          output_path: string | null
          output_size_bytes: number | null
          parent_job_id: string | null
          processing_started_at: string | null
          profile_id: string | null
          profile_snapshot: Json | null
          progress_message: string | null
          progress_percent: number | null
          qc_checklist_status: Json | null
          render_backend: string
          render_queue: Json | null
          requested_by: string
          retry_count: number
          slack_channel: string | null
          slack_message_ts: string | null
          slack_notified_at: string | null
          slack_notified_status: string | null
          slack_thread_ts: string | null
          source_files: Json
          status: string
          total_frames: number | null
          updated_at: string
        }
        Insert: {
          ae_comp?: string | null
          ae_is_movie?: boolean
          ae_output_dir?: string | null
          ae_output_module_template?: string | null
          ae_output_pattern?: string | null
          ae_project_path?: string | null
          ae_render_settings_template?: string | null
          ae_rqindex?: number | null
          aerender_command?: string | null
          chunk_count?: number | null
          chunk_index?: number | null
          claimed_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          created_at?: string
          deadline_jobs?: Json | null
          delivery_profile_id?: string | null
          duration_seconds?: number | null
          error_message?: string | null
          ffmpeg_command?: string | null
          frame_end?: number | null
          frame_rate?: string | null
          frame_start?: number | null
          id?: string
          job_type?: string
          max_retries?: number
          naming_fields?: Json | null
          output_filename?: string | null
          output_path?: string | null
          output_size_bytes?: number | null
          parent_job_id?: string | null
          processing_started_at?: string | null
          profile_id?: string | null
          profile_snapshot?: Json | null
          progress_message?: string | null
          progress_percent?: number | null
          qc_checklist_status?: Json | null
          render_backend?: string
          render_queue?: Json | null
          requested_by: string
          retry_count?: number
          slack_channel?: string | null
          slack_message_ts?: string | null
          slack_notified_at?: string | null
          slack_notified_status?: string | null
          slack_thread_ts?: string | null
          source_files: Json
          status?: string
          total_frames?: number | null
          updated_at?: string
        }
        Update: {
          ae_comp?: string | null
          ae_is_movie?: boolean
          ae_output_dir?: string | null
          ae_output_module_template?: string | null
          ae_output_pattern?: string | null
          ae_project_path?: string | null
          ae_render_settings_template?: string | null
          ae_rqindex?: number | null
          aerender_command?: string | null
          chunk_count?: number | null
          chunk_index?: number | null
          claimed_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          created_at?: string
          deadline_jobs?: Json | null
          delivery_profile_id?: string | null
          duration_seconds?: number | null
          error_message?: string | null
          ffmpeg_command?: string | null
          frame_end?: number | null
          frame_rate?: string | null
          frame_start?: number | null
          id?: string
          job_type?: string
          max_retries?: number
          naming_fields?: Json | null
          output_filename?: string | null
          output_path?: string | null
          output_size_bytes?: number | null
          parent_job_id?: string | null
          processing_started_at?: string | null
          profile_id?: string | null
          profile_snapshot?: Json | null
          progress_message?: string | null
          progress_percent?: number | null
          qc_checklist_status?: Json | null
          render_backend?: string
          render_queue?: Json | null
          requested_by?: string
          retry_count?: number
          slack_channel?: string | null
          slack_message_ts?: string | null
          slack_notified_at?: string | null
          slack_notified_status?: string | null
          slack_thread_ts?: string | null
          source_files?: Json
          status?: string
          total_frames?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "render_jobs_delivery_profile_id_fkey"
            columns: ["delivery_profile_id"]
            isOneToOne: false
            referencedRelation: "delivery_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "render_jobs_parent_job_id_fkey"
            columns: ["parent_job_id"]
            isOneToOne: false
            referencedRelation: "render_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "render_jobs_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "delivery_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      render_workers: {
        Row: {
          ae_capable: boolean
          ae_version: string | null
          aerender_path: string | null
          cpu_threshold: number
          cpu_usage_percent: number | null
          current_job_id: string | null
          disk_free_gb: number | null
          display_name: string | null
          dropbox_sync_path: string | null
          ffmpeg_path: string
          ffmpeg_version: string | null
          hostname: string
          id: string
          last_heartbeat: string | null
          max_concurrent_jobs: number
          memory_usage_percent: number | null
          opted_out_at: string | null
          opted_out_by: string | null
          opted_out_reason: string | null
          os_version: string | null
          priority: number
          registered_at: string
          role: string
          status: string
        }
        Insert: {
          ae_capable?: boolean
          ae_version?: string | null
          aerender_path?: string | null
          cpu_threshold?: number
          cpu_usage_percent?: number | null
          current_job_id?: string | null
          disk_free_gb?: number | null
          display_name?: string | null
          dropbox_sync_path?: string | null
          ffmpeg_path?: string
          ffmpeg_version?: string | null
          hostname: string
          id?: string
          last_heartbeat?: string | null
          max_concurrent_jobs?: number
          memory_usage_percent?: number | null
          opted_out_at?: string | null
          opted_out_by?: string | null
          opted_out_reason?: string | null
          os_version?: string | null
          priority?: number
          registered_at?: string
          role?: string
          status?: string
        }
        Update: {
          ae_capable?: boolean
          ae_version?: string | null
          aerender_path?: string | null
          cpu_threshold?: number
          cpu_usage_percent?: number | null
          current_job_id?: string | null
          disk_free_gb?: number | null
          display_name?: string | null
          dropbox_sync_path?: string | null
          ffmpeg_path?: string
          ffmpeg_version?: string | null
          hostname?: string
          id?: string
          last_heartbeat?: string | null
          max_concurrent_jobs?: number
          memory_usage_percent?: number | null
          opted_out_at?: string | null
          opted_out_by?: string | null
          opted_out_reason?: string | null
          os_version?: string | null
          priority?: number
          registered_at?: string
          role?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "render_workers_current_job_id_fkey"
            columns: ["current_job_id"]
            isOneToOne: false
            referencedRelation: "render_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      review_extractions: {
        Row: {
          asset_id: string
          asset_name: string
          created_at: string
          id: string
          notes: Json
          slack_channel_id: string | null
          slack_thread_ts: string | null
          source_url: string | null
          thumbnails_found: number | null
          total_comments: number | null
          workspace_id: string | null
        }
        Insert: {
          asset_id: string
          asset_name: string
          created_at?: string
          id?: string
          notes?: Json
          slack_channel_id?: string | null
          slack_thread_ts?: string | null
          source_url?: string | null
          thumbnails_found?: number | null
          total_comments?: number | null
          workspace_id?: string | null
        }
        Update: {
          asset_id?: string
          asset_name?: string
          created_at?: string
          id?: string
          notes?: Json
          slack_channel_id?: string | null
          slack_thread_ts?: string | null
          source_url?: string | null
          thumbnails_found?: number | null
          total_comments?: number | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "review_extractions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      scope_events: {
        Row: {
          classification: string | null
          created_at: string | null
          description: string
          estimated_cost: number | null
          estimated_hours: number | null
          feedback_item_id: string | null
          id: string
          project_id: string
          resolution: string | null
          workspace_id: string
        }
        Insert: {
          classification?: string | null
          created_at?: string | null
          description: string
          estimated_cost?: number | null
          estimated_hours?: number | null
          feedback_item_id?: string | null
          id?: string
          project_id: string
          resolution?: string | null
          workspace_id: string
        }
        Update: {
          classification?: string | null
          created_at?: string | null
          description?: string
          estimated_cost?: number | null
          estimated_hours?: number | null
          feedback_item_id?: string | null
          id?: string
          project_id?: string
          resolution?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "scope_events_feedback_item_id_fkey"
            columns: ["feedback_item_id"]
            isOneToOne: false
            referencedRelation: "feedback_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scope_events_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scope_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      seen_dropbox_files: {
        Row: {
          dropbox_id: string
          first_seen_at: string
          notified_at: string | null
          path: string
          size_bytes: number | null
          stable_check_count: number
        }
        Insert: {
          dropbox_id: string
          first_seen_at?: string
          notified_at?: string | null
          path: string
          size_bytes?: number | null
          stable_check_count?: number
        }
        Update: {
          dropbox_id?: string
          first_seen_at?: string
          notified_at?: string | null
          path?: string
          size_bytes?: number | null
          stable_check_count?: number
        }
        Relationships: []
      }
      sentiment_snapshots: {
        Row: {
          analysis: Json | null
          client_latest_signal: string | null
          client_satisfaction: number | null
          client_trend: string | null
          created_at: string | null
          id: string
          project_id: string
          snapshot_date: string
          team_morale: number | null
          team_notes: string | null
          team_trend: string | null
          workspace_id: string
        }
        Insert: {
          analysis?: Json | null
          client_latest_signal?: string | null
          client_satisfaction?: number | null
          client_trend?: string | null
          created_at?: string | null
          id?: string
          project_id: string
          snapshot_date: string
          team_morale?: number | null
          team_notes?: string | null
          team_trend?: string | null
          workspace_id: string
        }
        Update: {
          analysis?: Json | null
          client_latest_signal?: string | null
          client_satisfaction?: number | null
          client_trend?: string | null
          created_at?: string | null
          id?: string
          project_id?: string
          snapshot_date?: string
          team_morale?: number | null
          team_notes?: string | null
          team_trend?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sentiment_snapshots_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sentiment_snapshots_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      staff: {
        Row: {
          briefing_channel_id: string | null
          created_at: string
          daily_checkin: boolean
          email: string | null
          email_aliases: string[]
          employment_type: string | null
          frameio_user_id: string | null
          full_name: string | null
          harvest_user_id: number | null
          id: string
          is_active: boolean
          role: string | null
          slack_user_id: string
          timezone: string | null
          updated_at: string
        }
        Insert: {
          briefing_channel_id?: string | null
          created_at?: string
          daily_checkin?: boolean
          email?: string | null
          email_aliases?: string[]
          employment_type?: string | null
          frameio_user_id?: string | null
          full_name?: string | null
          harvest_user_id?: number | null
          id?: string
          is_active?: boolean
          role?: string | null
          slack_user_id: string
          timezone?: string | null
          updated_at?: string
        }
        Update: {
          briefing_channel_id?: string | null
          created_at?: string
          daily_checkin?: boolean
          email?: string | null
          email_aliases?: string[]
          employment_type?: string | null
          frameio_user_id?: string | null
          full_name?: string | null
          harvest_user_id?: number | null
          id?: string
          is_active?: boolean
          role?: string | null
          slack_user_id?: string
          timezone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      storyboard_jobs: {
        Row: {
          aspect_ratio: string | null
          boords_storyboard_id: string | null
          boords_url: string | null
          channel_id: string | null
          created_at: string
          frames: Json
          id: string
          last_error: string | null
          last_frame_index: number
          mode_used: string | null
          project_name: string
          seconds_per_frame: number | null
          status: string
          updated_at: string
          user_id: string | null
          video_style: string | null
          workspace_id: string | null
        }
        Insert: {
          aspect_ratio?: string | null
          boords_storyboard_id?: string | null
          boords_url?: string | null
          channel_id?: string | null
          created_at?: string
          frames: Json
          id?: string
          last_error?: string | null
          last_frame_index?: number
          mode_used?: string | null
          project_name: string
          seconds_per_frame?: number | null
          status?: string
          updated_at?: string
          user_id?: string | null
          video_style?: string | null
          workspace_id?: string | null
        }
        Update: {
          aspect_ratio?: string | null
          boords_storyboard_id?: string | null
          boords_url?: string | null
          channel_id?: string | null
          created_at?: string
          frames?: Json
          id?: string
          last_error?: string | null
          last_frame_index?: number
          mode_used?: string | null
          project_name?: string
          seconds_per_frame?: number | null
          status?: string
          updated_at?: string
          user_id?: string | null
          video_style?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "storyboard_jobs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      storyboard_panels: {
        Row: {
          action: string
          angle: string | null
          created_at: string
          dialogue: string | null
          duration: string | null
          generation_task_id: string | null
          id: string
          movement: string | null
          panel_number: number
          project_id: string
          scene_number: number
          shot_size: string
          status: string
          transition: string | null
        }
        Insert: {
          action: string
          angle?: string | null
          created_at?: string
          dialogue?: string | null
          duration?: string | null
          generation_task_id?: string | null
          id?: string
          movement?: string | null
          panel_number: number
          project_id: string
          scene_number: number
          shot_size: string
          status?: string
          transition?: string | null
        }
        Update: {
          action?: string
          angle?: string | null
          created_at?: string
          dialogue?: string | null
          duration?: string | null
          generation_task_id?: string | null
          id?: string
          movement?: string | null
          panel_number?: number
          project_id?: string
          scene_number?: number
          shot_size?: string
          status?: string
          transition?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "storyboard_panels_generation_task_id_fkey"
            columns: ["generation_task_id"]
            isOneToOne: false
            referencedRelation: "generation_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "storyboard_panels_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      team_members: {
        Row: {
          accepted_at: string | null
          auth_user_id: string | null
          avatar_url: string | null
          clockify_user_id: string | null
          created_at: string | null
          email: string
          frameio_user_id: string | null
          harvest_user_id: string | null
          hourly_rate: number | null
          id: string
          invited_at: string | null
          invited_by: string | null
          is_active: boolean | null
          name: string
          notification_preferences: Json | null
          notion_user_id: string | null
          permission_tier: string
          role: string
          slack_user_id: string | null
          updated_at: string | null
          workspace_id: string
        }
        Insert: {
          accepted_at?: string | null
          auth_user_id?: string | null
          avatar_url?: string | null
          clockify_user_id?: string | null
          created_at?: string | null
          email: string
          frameio_user_id?: string | null
          harvest_user_id?: string | null
          hourly_rate?: number | null
          id?: string
          invited_at?: string | null
          invited_by?: string | null
          is_active?: boolean | null
          name: string
          notification_preferences?: Json | null
          notion_user_id?: string | null
          permission_tier?: string
          role: string
          slack_user_id?: string | null
          updated_at?: string | null
          workspace_id: string
        }
        Update: {
          accepted_at?: string | null
          auth_user_id?: string | null
          avatar_url?: string | null
          clockify_user_id?: string | null
          created_at?: string | null
          email?: string
          frameio_user_id?: string | null
          harvest_user_id?: string | null
          hourly_rate?: number | null
          id?: string
          invited_at?: string | null
          invited_by?: string | null
          is_active?: boolean | null
          name?: string
          notification_preferences?: Json | null
          notion_user_id?: string | null
          permission_tier?: string
          role?: string
          slack_user_id?: string | null
          updated_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      templates: {
        Row: {
          category: string
          content: string
          created_at: string | null
          description: string | null
          id: string
          is_active: boolean | null
          name: string
          variables: Json | null
          workspace_id: string
        }
        Insert: {
          category: string
          content: string
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          variables?: Json | null
          workspace_id: string
        }
        Update: {
          category?: string
          content?: string
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          variables?: Json | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "templates_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      time_entries: {
        Row: {
          cost: number | null
          date: string
          description: string | null
          entry_source: string | null
          external_entry_id: string | null
          hours: number
          id: string
          project_id: string | null
          synced_at: string | null
          task_category: string | null
          team_member_id: string | null
          vendor_name: string | null
          workspace_id: string
        }
        Insert: {
          cost?: number | null
          date: string
          description?: string | null
          entry_source?: string | null
          external_entry_id?: string | null
          hours: number
          id?: string
          project_id?: string | null
          synced_at?: string | null
          task_category?: string | null
          team_member_id?: string | null
          vendor_name?: string | null
          workspace_id: string
        }
        Update: {
          cost?: number | null
          date?: string
          description?: string | null
          entry_source?: string | null
          external_entry_id?: string | null
          hours?: number
          id?: string
          project_id?: string | null
          synced_at?: string | null
          task_category?: string | null
          team_member_id?: string | null
          vendor_name?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "time_entries_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_entries_team_member_id_fkey"
            columns: ["team_member_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_entries_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      transcription_routing: {
        Row: {
          created_at: string | null
          id: string
          priority: number | null
          rule_type: string
          rule_value: string
          target_stream: string
          workspace_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          priority?: number | null
          rule_type: string
          rule_value: string
          target_stream: string
          workspace_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          priority?: number | null
          rule_type?: string
          rule_value?: string
          target_stream?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "transcription_routing_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workback_schedules: {
        Row: {
          confidence_notes: string | null
          confidence_score: number | null
          created_at: string | null
          historical_comparison: string | null
          id: string
          is_active: boolean | null
          open_questions: Json | null
          project_id: string
          risks: Json | null
          schedule: Json
          version: number | null
          workspace_id: string
        }
        Insert: {
          confidence_notes?: string | null
          confidence_score?: number | null
          created_at?: string | null
          historical_comparison?: string | null
          id?: string
          is_active?: boolean | null
          open_questions?: Json | null
          project_id: string
          risks?: Json | null
          schedule: Json
          version?: number | null
          workspace_id: string
        }
        Update: {
          confidence_notes?: string | null
          confidence_score?: number | null
          created_at?: string | null
          historical_comparison?: string | null
          id?: string
          is_active?: boolean | null
          open_questions?: Json | null
          project_id?: string
          risks?: Json | null
          schedule?: Json
          version?: number | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workback_schedules_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workback_schedules_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_config: {
        Row: {
          config_key: string
          config_value: Json
          id: string
          updated_at: string | null
          workspace_id: string
        }
        Insert: {
          config_key: string
          config_value: Json
          id?: string
          updated_at?: string | null
          workspace_id: string
        }
        Update: {
          config_key?: string
          config_value?: Json
          id?: string
          updated_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_config_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          created_at: string | null
          id: string
          logo_url: string | null
          name: string
          onboarding_completed: boolean | null
          plan: string | null
          settings: Json | null
          slack_team_id: string | null
          slug: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          logo_url?: string | null
          name: string
          onboarding_completed?: boolean | null
          plan?: string | null
          settings?: Json | null
          slack_team_id?: string | null
          slug: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          logo_url?: string | null
          name?: string
          onboarding_completed?: boolean | null
          plan?: string | null
          settings?: Json | null
          slack_team_id?: string | null
          slug?: string
          updated_at?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      check_slug_available: { Args: { p_slug: string }; Returns: boolean }
      create_workspace: {
        Args: {
          p_name: string
          p_slug: string
          p_user_email: string
          p_user_name: string
        }
        Returns: Json
      }
      get_user_tier: { Args: { ws_id: string }; Returns: string }
      get_user_workspace_ids: { Args: never; Returns: string[] }
      is_founder: { Args: { ws_id: string }; Returns: boolean }
      is_founder_or_producer: { Args: { ws_id: string }; Returns: boolean }
      match_documents: {
        Args: {
          filter_project_id?: string
          filter_workspace_id?: string
          match_count?: number
          query_embedding: string
        }
        Returns: {
          content: string
          doc_type: string
          id: string
          metadata: Json
          project_id: string
          similarity: number
          source_url: string
          title: string
          workspace_id: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
