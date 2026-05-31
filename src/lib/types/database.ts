export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      book_catalog: {
        Row: {
          attempt_count: number
          author: string | null
          cover_aspect: number | null
          cover_attempted_at: string | null
          cover_attempts: number
          cover_bytes_per_pixel: number | null
          cover_fail_reason: string | null
          cover_max_width: number | null
          cover_source: string | null
          cover_storage_backend: string | null
          description: string | null
          description_attempted_at: string | null
          description_attempts: number
          description_fail_reason: string | null
          description_provider: string | null
          description_raw: string | null
          do_not_refetch_description: boolean
          fetched_at: string
          gb_image_link_tiers: string[] | null
          gb_pdf_available: boolean | null
          gb_viewability: string | null
          google_volume_id: string | null
          id: string
          image_sha256: string | null
          isbn: string | null
          isbn_10: string | null
          language: string | null
          last_attempted_at: string
          normalized_title_author: string | null
          openlibrary_cover_id: number | null
          page_count: number | null
          page_count_attempted_at: string | null
          page_count_attempts: number
          page_count_fail_reason: string | null
          page_count_provider: string | null
          pending_storage: boolean
          published_date: string | null
          published_date_attempted_at: string | null
          published_date_attempts: number
          published_date_fail_reason: string | null
          published_date_provider: string | null
          publisher: string | null
          publisher_attempted_at: string | null
          publisher_attempts: number
          publisher_fail_reason: string | null
          publisher_provider: string | null
          series_name: string | null
          series_position: number | null
          source_url: string | null
          storage_path: string | null
          subjects: string[] | null
          subjects_attempted_at: string | null
          subjects_attempts: number
          subjects_fail_reason: string | null
          subjects_provider: string | null
          title: string | null
        }
        Insert: {
          attempt_count?: number
          author?: string | null
          cover_aspect?: number | null
          cover_attempted_at?: string | null
          cover_attempts?: number
          cover_bytes_per_pixel?: number | null
          cover_fail_reason?: string | null
          cover_max_width?: number | null
          cover_source?: string | null
          cover_storage_backend?: string | null
          description?: string | null
          description_attempted_at?: string | null
          description_attempts?: number
          description_fail_reason?: string | null
          description_provider?: string | null
          description_raw?: string | null
          do_not_refetch_description?: boolean
          fetched_at?: string
          gb_image_link_tiers?: string[] | null
          gb_pdf_available?: boolean | null
          gb_viewability?: string | null
          google_volume_id?: string | null
          id?: string
          image_sha256?: string | null
          isbn?: string | null
          isbn_10?: string | null
          language?: string | null
          last_attempted_at?: string
          normalized_title_author?: string | null
          openlibrary_cover_id?: number | null
          page_count?: number | null
          page_count_attempted_at?: string | null
          page_count_attempts?: number
          page_count_fail_reason?: string | null
          page_count_provider?: string | null
          pending_storage?: boolean
          published_date?: string | null
          published_date_attempted_at?: string | null
          published_date_attempts?: number
          published_date_fail_reason?: string | null
          published_date_provider?: string | null
          publisher?: string | null
          publisher_attempted_at?: string | null
          publisher_attempts?: number
          publisher_fail_reason?: string | null
          publisher_provider?: string | null
          series_name?: string | null
          series_position?: number | null
          source_url?: string | null
          storage_path?: string | null
          subjects?: string[] | null
          subjects_attempted_at?: string | null
          subjects_attempts?: number
          subjects_fail_reason?: string | null
          subjects_provider?: string | null
          title?: string | null
        }
        Update: {
          attempt_count?: number
          author?: string | null
          cover_aspect?: number | null
          cover_attempted_at?: string | null
          cover_attempts?: number
          cover_bytes_per_pixel?: number | null
          cover_fail_reason?: string | null
          cover_max_width?: number | null
          cover_source?: string | null
          cover_storage_backend?: string | null
          description?: string | null
          description_attempted_at?: string | null
          description_attempts?: number
          description_fail_reason?: string | null
          description_provider?: string | null
          description_raw?: string | null
          do_not_refetch_description?: boolean
          fetched_at?: string
          gb_image_link_tiers?: string[] | null
          gb_pdf_available?: boolean | null
          gb_viewability?: string | null
          google_volume_id?: string | null
          id?: string
          image_sha256?: string | null
          isbn?: string | null
          isbn_10?: string | null
          language?: string | null
          last_attempted_at?: string
          normalized_title_author?: string | null
          openlibrary_cover_id?: number | null
          page_count?: number | null
          page_count_attempted_at?: string | null
          page_count_attempts?: number
          page_count_fail_reason?: string | null
          page_count_provider?: string | null
          pending_storage?: boolean
          published_date?: string | null
          published_date_attempted_at?: string | null
          published_date_attempts?: number
          published_date_fail_reason?: string | null
          published_date_provider?: string | null
          publisher?: string | null
          publisher_attempted_at?: string | null
          publisher_attempts?: number
          publisher_fail_reason?: string | null
          publisher_provider?: string | null
          series_name?: string | null
          series_position?: number | null
          source_url?: string | null
          storage_path?: string | null
          subjects?: string[] | null
          subjects_attempted_at?: string | null
          subjects_attempts?: number
          subjects_fail_reason?: string | null
          subjects_provider?: string | null
          title?: string | null
        }
        Relationships: []
      }
      book_transfers: {
        Row: {
          attempt_count: number
          device_id: string | null
          downloaded_at: string | null
          file_size: number
          filename: string | null
          id: string
          last_attempt_at: string | null
          last_error: string | null
          scrubbed_at: string | null
          sha256: string | null
          sha256_verified: string | null
          status: string
          storage_path: string | null
          uploaded_at: string
          user_id: string
          verified_at: string | null
        }
        Insert: {
          attempt_count?: number
          device_id?: string | null
          downloaded_at?: string | null
          file_size: number
          filename?: string | null
          id?: string
          last_attempt_at?: string | null
          last_error?: string | null
          scrubbed_at?: string | null
          sha256?: string | null
          sha256_verified?: string | null
          status?: string
          storage_path?: string | null
          uploaded_at?: string
          user_id: string
          verified_at?: string | null
        }
        Update: {
          attempt_count?: number
          device_id?: string | null
          downloaded_at?: string | null
          file_size?: number
          filename?: string | null
          id?: string
          last_attempt_at?: string | null
          last_error?: string | null
          scrubbed_at?: string | null
          sha256?: string | null
          sha256_verified?: string | null
          status?: string
          storage_path?: string | null
          uploaded_at?: string
          user_id?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "book_transfers_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "book_transfers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      books: {
        Row: {
          author: string | null
          book_hash: string
          created_at: string
          id: string
          isbn: string | null
          language: string | null
          published_date: string | null
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          author?: string | null
          book_hash: string
          created_at?: string
          id?: string
          isbn?: string | null
          language?: string | null
          published_date?: string | null
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          author?: string | null
          book_hash?: string
          created_at?: string
          id?: string
          isbn?: string | null
          language?: string | null
          published_date?: string | null
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "books_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      catalog_admin_actions: {
        Row: {
          action: string
          admin_user_id: string
          after_jsonb: Json | null
          before_jsonb: Json | null
          catalog_id: string
          created_at: string
          id: string
          isbn: string | null
        }
        Insert: {
          action: string
          admin_user_id: string
          after_jsonb?: Json | null
          before_jsonb?: Json | null
          catalog_id: string
          created_at?: string
          id?: string
          isbn?: string | null
        }
        Update: {
          action?: string
          admin_user_id?: string
          after_jsonb?: Json | null
          before_jsonb?: Json | null
          catalog_id?: string
          created_at?: string
          id?: string
          isbn?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "catalog_admin_actions_catalog_id_fkey"
            columns: ["catalog_id"]
            isOneToOne: false
            referencedRelation: "book_catalog"
            referencedColumns: ["id"]
          },
        ]
      }
      catalog_dlq_archive: {
        Row: {
          archived_at: string
          fail_reason: string | null
          first_failed_at: string
          id: number
          manually_requeued_at: string | null
          message_id: string
          payload: Json
        }
        Insert: {
          archived_at?: string
          fail_reason?: string | null
          first_failed_at: string
          id?: number
          manually_requeued_at?: string | null
          message_id: string
          payload: Json
        }
        Update: {
          archived_at?: string
          fail_reason?: string | null
          first_failed_at?: string
          id?: number
          manually_requeued_at?: string | null
          message_id?: string
          payload?: Json
        }
        Relationships: []
      }
      catalog_fill_rate_history: {
        Row: {
          desc_from_google_books: number
          desc_from_itunes: number
          desc_from_manual: number
          desc_from_openlibrary: number
          missing_cover: number
          missing_description: number
          missing_page_count: number
          missing_published_date: number
          missing_publisher: number
          missing_subjects: number
          snapshot_at: string
          total_rows: number
        }
        Insert: {
          desc_from_google_books: number
          desc_from_itunes: number
          desc_from_manual: number
          desc_from_openlibrary: number
          missing_cover: number
          missing_description: number
          missing_page_count: number
          missing_published_date: number
          missing_publisher: number
          missing_subjects: number
          snapshot_at?: string
          total_rows: number
        }
        Update: {
          desc_from_google_books?: number
          desc_from_itunes?: number
          desc_from_manual?: number
          desc_from_openlibrary?: number
          missing_cover?: number
          missing_description?: number
          missing_page_count?: number
          missing_published_date?: number
          missing_publisher?: number
          missing_subjects?: number
          snapshot_at?: string
          total_rows?: number
        }
        Relationships: []
      }
      devices: {
        Row: {
          api_token_hash: string
          created_at: string
          hardware_id: string
          id: string
          last_synced_at: string | null
          last_used_at: string | null
          name: string
          paired_at: string
          revoked_at: string | null
          user_id: string
        }
        Insert: {
          api_token_hash: string
          created_at?: string
          hardware_id: string
          id?: string
          last_synced_at?: string | null
          last_used_at?: string | null
          name?: string
          paired_at?: string
          revoked_at?: string | null
          user_id: string
        }
        Update: {
          api_token_hash?: string
          created_at?: string
          hardware_id?: string
          id?: string
          last_synced_at?: string | null
          last_used_at?: string | null
          name?: string
          paired_at?: string
          revoked_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "devices_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      highlights: {
        Row: {
          book_id: string
          chapter_index: number
          chapter_title: string | null
          created_at: string
          deleted_at: string | null
          device_timestamp_raw: number | null
          end_word: number
          id: string
          paragraph_breaks: Json | null
          start_word: number
          styles: string | null
          text: string
          updated_at: string
          user_id: string
        }
        Insert: {
          book_id: string
          chapter_index: number
          chapter_title?: string | null
          created_at?: string
          deleted_at?: string | null
          device_timestamp_raw?: number | null
          end_word: number
          id?: string
          paragraph_breaks?: Json | null
          start_word: number
          styles?: string | null
          text: string
          updated_at?: string
          user_id: string
        }
        Update: {
          book_id?: string
          chapter_index?: number
          chapter_title?: string | null
          created_at?: string
          deleted_at?: string | null
          device_timestamp_raw?: number | null
          end_word?: number
          id?: string
          paragraph_breaks?: Json | null
          start_word?: number
          styles?: string | null
          text?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "highlights_book_id_user_id_fkey"
            columns: ["book_id", "user_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      notes: {
        Row: {
          created_at: string
          deleted_at: string | null
          highlight_id: string
          id: string
          text: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          highlight_id: string
          id?: string
          text: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          highlight_id?: string
          id?: string
          text?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notes_highlight_id_user_id_fkey"
            columns: ["highlight_id", "user_id"]
            isOneToOne: false
            referencedRelation: "highlights"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      pairing_codes: {
        Row: {
          claim_attempts: number
          claimed: boolean
          code: string
          created_at: string
          expires_at: string
          hardware_id: string
          id: string
          poll_secret_hash: string
          user_email: string | null
          user_id: string | null
        }
        Insert: {
          claim_attempts?: number
          claimed?: boolean
          code: string
          created_at?: string
          expires_at: string
          hardware_id: string
          id?: string
          poll_secret_hash: string
          user_email?: string | null
          user_id?: string | null
        }
        Update: {
          claim_attempts?: number
          claimed?: boolean
          code?: string
          created_at?: string
          expires_at?: string
          hardware_id?: string
          id?: string
          poll_secret_hash?: string
          user_email?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pairing_codes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          is_admin: boolean
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id: string
          is_admin?: boolean
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          is_admin?: boolean
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      _field_replay_due: {
        Args: { p_attempted_at: string; p_fail_reason: string }
        Returns: boolean
      }
      admin_apply_action: {
        Args: {
          p_action: string
          p_admin_user_id: string
          p_catalog_id: string
          p_patch_jsonb: Json
        }
        Returns: string
      }
      claim_pairing_atomic: {
        Args: {
          p_max_attempts: number
          p_pairing_id: string
          p_token_hash: string
          p_user_email: string
          p_user_id: string
        }
        Returns: {
          device_id: string
          device_name: string
          expired: boolean
          won: boolean
        }[]
      }
      compute_catalog_fill_rate: {
        Args: never
        Returns: {
          desc_from_google_books: number
          desc_from_itunes: number
          desc_from_manual: number
          desc_from_openlibrary: number
          missing_cover: number
          missing_description: number
          missing_page_count: number
          missing_published_date: number
          missing_publisher: number
          missing_subjects: number
          total_rows: number
        }[]
      }
      ensure_realtime: { Args: { p_table: unknown }; Returns: undefined }
      get_highlight_feed: {
        Args: {
          p_book_hash: string
          p_cursor: Json
          p_limit: number
          p_sort: string
        }
        Returns: {
          book_author: string
          book_hash: string
          book_highlight_count: number
          book_isbn: string
          book_title: string
          chapter_index: number
          chapter_title: string
          end_word: number
          highlight_id: string
          next_cursor: Json
          note_text: string
          note_updated_at: string
          paragraph_breaks: Json
          start_word: number
          styles: string
          text: string
          updated_at: string
        }[]
      }
      get_library_with_highlights: { Args: never; Returns: Json }
      increment_transfer_attempt: {
        Args: { p_max_attempts?: number; p_transfer_id: string }
        Returns: {
          attempt_count: number
          status: string
        }[]
      }
      merge_ta_catalog_dups: {
        Args: {
          p_admin_user_id: string
          p_loser_ids: string[]
          p_survivor_id: string
        }
        Returns: number
      }
      pg_cron_failure_summary: {
        Args: never
        Returns: {
          failures: number
          jobname: string
        }[]
      }
      promote_ta_to_isbn: {
        Args: { p_isbn: string; p_ta_key: string }
        Returns: boolean
      }
      requeue_catalog_resolve: {
        Args: { p_fields: string[]; p_id: string }
        Returns: undefined
      }
      rollback_claim_pairing: {
        Args: { p_pairing_id: string; p_user_id: string }
        Returns: undefined
      }
      select_replay_candidates: {
        Args: { p_limit: number }
        Returns: {
          author: string
          id: string
          isbn: string
          normalized_title_author: string
          replay_fields: string[]
          title: string
        }[]
      }
      soft_delete_highlights: {
        Args: { p_now: string; p_rows: Json; p_user_id: string }
        Returns: number
      }
      upsert_book_catalog_by_isbn: { Args: { p_row: Json }; Returns: undefined }
      upsert_book_catalog_by_title_author: {
        Args: { p_row: Json }
        Returns: undefined
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

