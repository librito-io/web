// drift-check test marker — will be reverted (PR closed without merge)
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
          cover_source: string | null
          cover_storage_backend: string | null
          description: string | null
          description_provider: string | null
          description_raw: string | null
          do_not_refetch_description: boolean
          fetched_at: string
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
          published_date: string | null
          publisher: string | null
          series_name: string | null
          series_position: number | null
          source_url: string | null
          storage_path: string | null
          subjects: string[] | null
          title: string | null
        }
        Insert: {
          attempt_count?: number
          author?: string | null
          cover_source?: string | null
          cover_storage_backend?: string | null
          description?: string | null
          description_provider?: string | null
          description_raw?: string | null
          do_not_refetch_description?: boolean
          fetched_at?: string
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
          published_date?: string | null
          publisher?: string | null
          series_name?: string | null
          series_position?: number | null
          source_url?: string | null
          storage_path?: string | null
          subjects?: string[] | null
          title?: string | null
        }
        Update: {
          attempt_count?: number
          author?: string | null
          cover_source?: string | null
          cover_storage_backend?: string | null
          description?: string | null
          description_provider?: string | null
          description_raw?: string | null
          do_not_refetch_description?: boolean
          fetched_at?: string
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
          published_date?: string | null
          publisher?: string | null
          series_name?: string | null
          series_position?: number | null
          source_url?: string | null
          storage_path?: string | null
          subjects?: string[] | null
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
          status: string
          storage_path: string | null
          uploaded_at: string
          user_id: string
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
          status?: string
          storage_path?: string | null
          uploaded_at?: string
          user_id: string
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
          status?: string
          storage_path?: string | null
          uploaded_at?: string
          user_id?: string
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
          cover_path: string | null
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
          cover_path?: string | null
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
          cover_path?: string | null
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
          claimed: boolean
          code: string
          created_at: string
          expires_at: string
          hardware_id: string
          id: string
          user_email: string | null
          user_id: string | null
        }
        Insert: {
          claimed?: boolean
          code: string
          created_at?: string
          expires_at: string
          hardware_id: string
          id?: string
          user_email?: string | null
          user_id?: string | null
        }
        Update: {
          claimed?: boolean
          code?: string
          created_at?: string
          expires_at?: string
          hardware_id?: string
          id?: string
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
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_pairing_atomic: {
        Args: {
          p_pairing_id: string
          p_token_hash: string
          p_user_email: string
          p_user_id: string
        }
        Returns: {
          device_id: string
          device_name: string
          won: boolean
        }[]
      }
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
      rollback_claim_pairing: {
        Args: { p_pairing_id: string; p_user_id: string }
        Returns: undefined
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

