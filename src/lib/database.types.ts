import type { Cadence, MonitorContentType, PlanName } from "@/lib/plans";
import type { AwardPageType } from "@/lib/award-discovery-types";

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];
export type OfficeRole = "owner" | "admin" | "member";
export type NotificationPreference = "immediate" | "daily_digest" | "both" | "none";
export type JobRunName = "check-monitors" | "send-digests";
export type JobRunStatus = "running" | "succeeded" | "failed";
export type PublicUpdateSubscriberStatus = "pending" | "active" | "unsubscribed";
export type PublicUpdateDeliveryStatus = "sent" | "failed";
export type PublicFormRateLimitKind = "subscribe" | "contact" | "source_request";
export type SourcePageRequestStatus = "pending" | "queued" | "added" | "rejected";
export type AwardWorkflowStatus =
  | "watching"
  | "needs_review"
  | "in_progress"
  | "ready"
  | "done";
export type AwardPriority = "normal" | "high";
export type AwardTaskStatus = "todo" | "done";

export type Database = {
  public: {
    Tables: {
      organizations: {
        Row: {
          id: string;
          name: string;
          normalized_name: string;
          country: string | null;
          country_code: string | null;
          state_province: string | null;
          domains: string[];
          web_pages: string[];
          source: "hipo" | "user" | "admin";
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          normalized_name: string;
          country?: string | null;
          country_code?: string | null;
          state_province?: string | null;
          domains?: string[];
          web_pages?: string[];
          source?: "hipo" | "user" | "admin";
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          name?: string;
          normalized_name?: string;
          country?: string | null;
          country_code?: string | null;
          state_province?: string | null;
          domains?: string[];
          web_pages?: string[];
          source?: "hipo" | "user" | "admin";
          created_by?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      offices: {
        Row: {
          id: string;
          name: string;
          organization_id: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          organization_id?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          name?: string;
          organization_id?: string | null;
          created_by?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      shared_awards: {
        Row: {
          id: string;
          search_key: string;
          name: string;
          official_homepage: string | null;
          summary: string | null;
          confidence: number;
          status: "active" | "archived";
          source: "seed" | "user" | "admin";
          submitted_by_user_id: string | null;
          last_structure_scan_at: string | null;
          next_structure_scan_at: string;
          structure_scan_error: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          search_key: string;
          name: string;
          official_homepage?: string | null;
          summary?: string | null;
          confidence?: number;
          status?: "active" | "archived";
          source?: "seed" | "user" | "admin";
          submitted_by_user_id?: string | null;
          last_structure_scan_at?: string | null;
          next_structure_scan_at?: string;
          structure_scan_error?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          official_homepage?: string | null;
          summary?: string | null;
          confidence?: number;
          status?: "active" | "archived";
          source?: "seed" | "user" | "admin";
          submitted_by_user_id?: string | null;
          last_structure_scan_at?: string | null;
          next_structure_scan_at?: string;
          structure_scan_error?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      shared_award_sources: {
        Row: {
          id: string;
          shared_award_id: string;
          url: string;
          title: string;
          page_type: AwardPageType;
          confidence: number;
          reason: string | null;
          source: "seed" | "user" | "admin";
          submitted_by_user_id: string | null;
          last_hash: string | null;
          last_checked_at: string | null;
          next_check_at: string;
          consecutive_failures: number;
          last_error: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          shared_award_id: string;
          url: string;
          title: string;
          page_type?: AwardPageType;
          confidence?: number;
          reason?: string | null;
          source?: "seed" | "user" | "admin";
          submitted_by_user_id?: string | null;
          last_hash?: string | null;
          last_checked_at?: string | null;
          next_check_at?: string;
          consecutive_failures?: number;
          last_error?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          title?: string;
          page_type?: AwardPageType;
          confidence?: number;
          reason?: string | null;
          source?: "seed" | "user" | "admin";
          last_hash?: string | null;
          last_checked_at?: string | null;
          next_check_at?: string;
          consecutive_failures?: number;
          last_error?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      shared_award_source_snapshots: {
        Row: {
          id: string;
          shared_award_id: string;
          shared_award_source_id: string | null;
          source_url: string;
          source_title: string | null;
          source_page_type: AwardPageType | null;
          hash: string;
          text_sample: string;
          byte_length: number;
          status_code: number | null;
          content_type: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          shared_award_id: string;
          shared_award_source_id?: string | null;
          source_url: string;
          source_title?: string | null;
          source_page_type?: AwardPageType | null;
          hash: string;
          text_sample: string;
          byte_length?: number;
          status_code?: number | null;
          content_type?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          shared_award_id?: string;
          shared_award_source_id?: string | null;
          source_url?: string;
          source_title?: string | null;
          source_page_type?: AwardPageType | null;
          hash?: string;
          text_sample?: string;
          byte_length?: number;
          status_code?: number | null;
          content_type?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      shared_award_change_events: {
        Row: {
          id: string;
          shared_award_id: string;
          shared_award_source_id: string | null;
          source_url: string;
          source_title: string | null;
          source_page_type: AwardPageType | null;
          previous_snapshot_id: string | null;
          new_snapshot_id: string | null;
          previous_hash: string;
          new_hash: string;
          summary: string;
          change_details: Json;
          first_reported_by_office_id: string | null;
          first_reported_by_monitor_id: string | null;
          detected_at: string;
        };
        Insert: {
          id?: string;
          shared_award_id: string;
          shared_award_source_id?: string | null;
          source_url: string;
          source_title?: string | null;
          source_page_type?: AwardPageType | null;
          previous_snapshot_id?: string | null;
          new_snapshot_id?: string | null;
          previous_hash: string;
          new_hash: string;
          summary: string;
          change_details?: Json;
          first_reported_by_office_id?: string | null;
          first_reported_by_monitor_id?: string | null;
          detected_at?: string;
        };
        Update: {
          summary?: string;
          change_details?: Json;
        };
        Relationships: [];
      };
      office_members: {
        Row: {
          id: string;
          office_id: string;
          user_id: string;
          email: string | null;
          role: OfficeRole;
          notification_preference: NotificationPreference;
          status: "active" | "invited";
          joined_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          office_id: string;
          user_id: string;
          email?: string | null;
          role?: OfficeRole;
          notification_preference?: NotificationPreference;
          status?: "active" | "invited";
          joined_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          email?: string | null;
          role?: OfficeRole;
          notification_preference?: NotificationPreference;
          status?: "active" | "invited";
          joined_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      office_invites: {
        Row: {
          id: string;
          office_id: string;
          email: string | null;
          role: Exclude<OfficeRole, "owner">;
          token_hash: string;
          invite_code: string;
          invited_by: string | null;
          accepted_by: string | null;
          accepted_at: string | null;
          expires_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          office_id: string;
          email?: string | null;
          role?: Exclude<OfficeRole, "owner">;
          token_hash: string;
          invite_code: string;
          invited_by?: string | null;
          accepted_by?: string | null;
          accepted_at?: string | null;
          expires_at?: string;
          created_at?: string;
        };
        Update: {
          accepted_by?: string | null;
          accepted_at?: string | null;
        };
        Relationships: [];
      };
      job_runs: {
        Row: {
          id: string;
          job_name: JobRunName;
          status: JobRunStatus;
          started_at: string;
          finished_at: string | null;
          processed_count: number;
          error: string | null;
          metadata: Json;
        };
        Insert: {
          id?: string;
          job_name: JobRunName;
          status?: JobRunStatus;
          started_at?: string;
          finished_at?: string | null;
          processed_count?: number;
          error?: string | null;
          metadata?: Json;
        };
        Update: {
          status?: JobRunStatus;
          finished_at?: string | null;
          processed_count?: number;
          error?: string | null;
          metadata?: Json;
        };
        Relationships: [];
      };
      public_update_subscribers: {
        Row: {
          id: string;
          email: string;
          status: PublicUpdateSubscriberStatus;
          confirmation_token_hash: string | null;
          unsubscribe_token_hash: string;
          confirmation_sent_at: string | null;
          confirmed_at: string | null;
          unsubscribed_at: string | null;
          last_digest_sent_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          email: string;
          status?: PublicUpdateSubscriberStatus;
          confirmation_token_hash?: string | null;
          unsubscribe_token_hash: string;
          confirmation_sent_at?: string | null;
          confirmed_at?: string | null;
          unsubscribed_at?: string | null;
          last_digest_sent_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          email?: string;
          status?: PublicUpdateSubscriberStatus;
          confirmation_token_hash?: string | null;
          unsubscribe_token_hash?: string;
          confirmation_sent_at?: string | null;
          confirmed_at?: string | null;
          unsubscribed_at?: string | null;
          last_digest_sent_at?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      public_update_deliveries: {
        Row: {
          id: string;
          subscriber_id: string;
          digest_key: string;
          change_event_ids: string[];
          recipient: string;
          status: PublicUpdateDeliveryStatus;
          error: string | null;
          sent_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          subscriber_id: string;
          digest_key: string;
          change_event_ids?: string[];
          recipient: string;
          status: PublicUpdateDeliveryStatus;
          error?: string | null;
          sent_at?: string;
          created_at?: string;
        };
        Update: never;
        Relationships: [];
      };
      public_form_rate_limits: {
        Row: {
          id: string;
          kind: PublicFormRateLimitKind;
          ip_hash: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          kind: PublicFormRateLimitKind;
          ip_hash: string;
          created_at?: string;
        };
        Update: never;
        Relationships: [];
      };
      source_page_requests: {
        Row: {
          id: string;
          user_id: string | null;
          office_id: string | null;
          award_name: string;
          homepage_url: string;
          notes: string | null;
          status: SourcePageRequestStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          office_id?: string | null;
          award_name: string;
          homepage_url: string;
          notes?: string | null;
          status?: SourcePageRequestStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          office_id?: string | null;
          award_name?: string;
          homepage_url?: string;
          notes?: string | null;
          status?: SourcePageRequestStatus;
          updated_at?: string;
        };
        Relationships: [];
      };
      local_worker_runs: {
        Row: {
          id: string;
          worker_name: string;
          status: "running" | "succeeded" | "failed";
          ai_provider: string | null;
          checked_count: number;
          changed_count: number;
          unchanged_count: number;
          initial_count: number;
          discovered_count: number;
          failed_count: number;
          error: string | null;
          started_at: string;
          finished_at: string | null;
        };
        Insert: {
          id?: string;
          worker_name?: string;
          status?: "running" | "succeeded" | "failed";
          ai_provider?: string | null;
          checked_count?: number;
          changed_count?: number;
          unchanged_count?: number;
          initial_count?: number;
          discovered_count?: number;
          failed_count?: number;
          error?: string | null;
          started_at?: string;
          finished_at?: string | null;
        };
        Update: {
          status?: "running" | "succeeded" | "failed";
          ai_provider?: string | null;
          checked_count?: number;
          changed_count?: number;
          unchanged_count?: number;
          initial_count?: number;
          discovered_count?: number;
          failed_count?: number;
          error?: string | null;
          finished_at?: string | null;
        };
        Relationships: [];
      };
      awards: {
        Row: {
          id: string;
          office_id: string | null;
          shared_award_id: string | null;
          user_id: string;
          name: string;
          official_homepage: string | null;
          summary: string | null;
          confidence: number;
          status: "active" | "archived";
          workflow_status: AwardWorkflowStatus;
          priority: AwardPriority;
          owner_member_id: string | null;
          last_reviewed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          office_id?: string | null;
          shared_award_id?: string | null;
          user_id: string;
          name: string;
          official_homepage?: string | null;
          summary?: string | null;
          confidence?: number;
          status?: "active" | "archived";
          workflow_status?: AwardWorkflowStatus;
          priority?: AwardPriority;
          owner_member_id?: string | null;
          last_reviewed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          office_id?: string | null;
          shared_award_id?: string | null;
          name?: string;
          official_homepage?: string | null;
          summary?: string | null;
          confidence?: number;
          status?: "active" | "archived";
          workflow_status?: AwardWorkflowStatus;
          priority?: AwardPriority;
          owner_member_id?: string | null;
          last_reviewed_at?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      award_notes: {
        Row: {
          id: string;
          office_id: string;
          award_id: string;
          author_user_id: string;
          author_member_id: string | null;
          body: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          office_id: string;
          award_id: string;
          author_user_id: string;
          author_member_id?: string | null;
          body: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          body?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      award_tasks: {
        Row: {
          id: string;
          office_id: string;
          award_id: string;
          created_by_user_id: string;
          assigned_member_id: string | null;
          title: string;
          status: AwardTaskStatus;
          completed_at: string | null;
          completed_by_user_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          office_id: string;
          award_id: string;
          created_by_user_id: string;
          assigned_member_id?: string | null;
          title: string;
          status?: AwardTaskStatus;
          completed_at?: string | null;
          completed_by_user_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          assigned_member_id?: string | null;
          title?: string;
          status?: AwardTaskStatus;
          completed_at?: string | null;
          completed_by_user_id?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      award_sources: {
        Row: {
          id: string;
          award_id: string;
          office_id: string | null;
          shared_award_source_id: string | null;
          user_id: string;
          url: string;
          title: string;
          page_type:
            | "homepage"
            | "deadline"
            | "application"
            | "eligibility"
            | "requirements"
            | "pdf"
            | "faq"
            | "other";
          confidence: number;
          reason: string | null;
          selected: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          award_id: string;
          office_id?: string | null;
          shared_award_source_id?: string | null;
          user_id: string;
          url: string;
          title: string;
          page_type?:
            | "homepage"
            | "deadline"
            | "application"
            | "eligibility"
            | "requirements"
            | "pdf"
            | "faq"
            | "other";
          confidence?: number;
          reason?: string | null;
          selected?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          office_id?: string | null;
          shared_award_source_id?: string | null;
          title?: string;
          page_type?:
            | "homepage"
            | "deadline"
            | "application"
            | "eligibility"
            | "requirements"
            | "pdf"
            | "faq"
            | "other";
          confidence?: number;
          reason?: string | null;
          selected?: boolean;
          updated_at?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          id: string;
          email: string | null;
          full_name: string | null;
          organization: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email?: string | null;
          full_name?: string | null;
          organization?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          email?: string | null;
          full_name?: string | null;
          organization?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      subscriptions: {
        Row: {
          id: string;
          user_id: string;
          plan: PlanName;
          status: string;
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          current_period_end: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          plan?: PlanName;
          status?: string;
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          current_period_end?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          plan?: PlanName;
          status?: string;
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          current_period_end?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      monitors: {
        Row: {
          id: string;
          office_id: string | null;
          user_id: string;
          award_id: string | null;
          shared_award_source_id: string | null;
          label: string;
          url: string;
          content_type: MonitorContentType;
          cadence: Cadence;
          page_type:
            | "homepage"
            | "deadline"
            | "application"
            | "eligibility"
            | "requirements"
            | "pdf"
            | "faq"
            | "other"
            | null;
          source_label: string | null;
          status: "active" | "paused" | "error";
          last_hash: string | null;
          last_checked_at: string | null;
          next_check_at: string;
          consecutive_failures: number;
          last_error: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          office_id?: string | null;
          user_id: string;
          award_id?: string | null;
          shared_award_source_id?: string | null;
          label: string;
          url: string;
          content_type?: MonitorContentType;
          cadence?: Cadence;
          page_type?:
            | "homepage"
            | "deadline"
            | "application"
            | "eligibility"
            | "requirements"
            | "pdf"
            | "faq"
            | "other"
            | null;
          source_label?: string | null;
          status?: "active" | "paused" | "error";
          next_check_at?: string;
        };
        Update: {
          office_id?: string | null;
          award_id?: string | null;
          shared_award_source_id?: string | null;
          label?: string;
          url?: string;
          content_type?: MonitorContentType;
          cadence?: Cadence;
          page_type?:
            | "homepage"
            | "deadline"
            | "application"
            | "eligibility"
            | "requirements"
            | "pdf"
            | "faq"
            | "other"
            | null;
          source_label?: string | null;
          status?: "active" | "paused" | "error";
          last_hash?: string | null;
          last_checked_at?: string | null;
          next_check_at?: string;
          consecutive_failures?: number;
          last_error?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      monitor_snapshots: {
        Row: {
          id: string;
          office_id: string | null;
          monitor_id: string;
          hash: string;
          text_sample: string;
          byte_length: number;
          status_code: number | null;
          content_type: string | null;
          created_at: string;
        };
        Insert: {
          office_id?: string | null;
          monitor_id: string;
          hash: string;
          text_sample: string;
          byte_length?: number;
          status_code?: number | null;
          content_type?: string | null;
        };
        Update: never;
        Relationships: [];
      };
      change_events: {
        Row: {
          id: string;
          office_id: string | null;
          monitor_id: string;
          previous_snapshot_id: string | null;
          new_snapshot_id: string | null;
          previous_hash: string | null;
          new_hash: string;
          summary: string;
          change_details: Json;
          detected_at: string;
          notified_at: string | null;
        };
        Insert: {
          office_id?: string | null;
          monitor_id: string;
          previous_snapshot_id?: string | null;
          new_snapshot_id?: string | null;
          previous_hash?: string | null;
          new_hash: string;
          summary: string;
          change_details?: Json;
          notified_at?: string | null;
        };
        Update: {
          office_id?: string | null;
          previous_snapshot_id?: string | null;
          new_snapshot_id?: string | null;
          summary?: string;
          change_details?: Json;
          notified_at?: string | null;
        };
        Relationships: [];
      };
      alert_deliveries: {
        Row: {
          id: string;
          office_id: string | null;
          office_member_id: string | null;
          change_event_id: string | null;
          user_id: string;
          channel: string;
          delivery_type: "immediate" | "digest";
          digest_key: string | null;
          recipient: string;
          status: string;
          error: string | null;
          created_at: string;
        };
        Insert: {
          office_id?: string | null;
          office_member_id?: string | null;
          change_event_id?: string | null;
          user_id: string;
          channel?: string;
          delivery_type?: "immediate" | "digest";
          digest_key?: string | null;
          recipient: string;
          status: string;
          error?: string | null;
        };
        Update: never;
        Relationships: [];
      };
      free_checks: {
        Row: {
          id: string;
          ip_hash: string | null;
          url: string;
          created_at: string;
        };
        Insert: {
          ip_hash?: string | null;
          url: string;
        };
        Update: never;
        Relationships: [];
      };
      discovery_requests: {
        Row: {
          id: string;
          user_id: string | null;
          ip_hash: string;
          query: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          ip_hash: string;
          query: string;
          created_at?: string;
        };
        Update: never;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      ensure_default_office_for_user: {
        Args: {
          target_user_id: string;
          target_email: string | null;
          target_organization_id?: string | null;
          target_office_name?: string | null;
        };
        Returns: string;
      };
      ensure_organization_for_name: {
        Args: {
          input_name: string | null;
          input_created_by?: string | null;
        };
        Returns: string | null;
      };
      seed_default_awards_for_office: {
        Args: {
          target_office_id: string;
          target_user_id: string;
        };
        Returns: number;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
