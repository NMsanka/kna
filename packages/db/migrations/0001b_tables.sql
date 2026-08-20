CREATE TYPE "public"."analysis_depth" AS ENUM('shallow', 'semantic', 'artifact');--> statement-breakpoint
CREATE TYPE "public"."git_provider" AS ENUM('github', 'azuredevops', 'gitlab', 'bitbucket', 'local');--> statement-breakpoint
CREATE TYPE "public"."language" AS ENUM('typescript', 'javascript', 'python', 'csharp', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."sensitivity_tier" AS ENUM('public', 'internal', 'confidential', 'restricted');--> statement-breakpoint
CREATE TABLE "module_projects" (
	"module_id" text NOT NULL,
	"project_id" text NOT NULL,
	"org_id" text NOT NULL,
	CONSTRAINT "module_projects_module_id_project_id_pk" PRIMARY KEY("module_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "modules" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"key" text NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"ecosystem" text DEFAULT 'none' NOT NULL,
	"package_name" text,
	"package_version" text,
	"languages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"sensitivity" "sensitivity_tier" DEFAULT 'internal' NOT NULL,
	"external_publication_approved_by" text,
	"external_publication_approved_at" timestamp with time zone,
	"analysis_depth" "analysis_depth" DEFAULT 'shallow' NOT NULL,
	"analysis_notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"owners" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dependencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"symbol_count" integer DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"indexed_commit_sha" text,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kms_key_ref" text,
	"data_region" text DEFAULT 'local' NOT NULL,
	"daily_spend_ceiling_usd" integer DEFAULT 500 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "orgs_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "permission_revocations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"repo_id" text,
	"reason" text NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "principals" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"subject" text NOT NULL,
	"email" text,
	"display_name" text,
	"clearance" "sensitivity_tier" DEFAULT 'internal' NOT NULL,
	"is_service_account" boolean DEFAULT false NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"owner_team" text,
	"readiness_score" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_permissions" (
	"principal_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"org_id" text NOT NULL,
	"level" text DEFAULT 'read' NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_permissions_principal_id_repo_id_pk" PRIMARY KEY("principal_id","repo_id")
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"remote" text NOT NULL,
	"name" text NOT NULL,
	"provider" "git_provider" DEFAULT 'local' NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"last_indexed_sha" text,
	"last_indexed_at" timestamp with time zone,
	"stale_since_sha" text,
	"stale_reason" text,
	"source_upload_enabled" boolean DEFAULT false NOT NULL,
	"source_upload_approved_by" text,
	"source_upload_approved_at" timestamp with time zone,
	"pending_bulk_review" boolean DEFAULT false NOT NULL,
	"pending_bulk_review_reason" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_specs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"module_id" text NOT NULL,
	"version_id" text NOT NULL,
	"spec_id" text NOT NULL,
	"title" text NOT NULL,
	"spec_version" text NOT NULL,
	"format" text NOT NULL,
	"document" jsonb NOT NULL,
	"document_hash" text NOT NULL,
	"source_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cross_repo_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"from_symbol_id" text NOT NULL,
	"to_symbol_id" text,
	"to_qualified_name" text,
	"kind" text NOT NULL,
	"evidence" text NOT NULL,
	"confidence" text DEFAULT 'certain' NOT NULL,
	"status" text DEFAULT 'resolved' NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ir_bundles" (
	"bundle_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"ref" text NOT NULL,
	"ir_schema_version" text NOT NULL,
	"producer_name" text NOT NULL,
	"producer_version" text NOT NULL,
	"environment" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"signature_algorithm" text NOT NULL,
	"signer_claims" jsonb,
	"nonce" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"upcasted_from" text,
	"scan_report" jsonb
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"module_id" text,
	"image" text,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_path" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "symbol_aliases" (
	"org_id" text NOT NULL,
	"previous_id" text NOT NULL,
	"current_id" text NOT NULL,
	"reason" text DEFAULT 'rename' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "symbol_aliases_org_id_previous_id_pk" PRIMARY KEY("org_id","previous_id")
);
--> statement-breakpoint
CREATE TABLE "symbols" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"module_id" text NOT NULL,
	"version_id" text NOT NULL,
	"qualified_name" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"language" "language" NOT NULL,
	"visibility" text NOT NULL,
	"signature" text NOT NULL,
	"signature_hash" text NOT NULL,
	"doc_hash" text,
	"body_hash" text,
	"parameters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"return_type" jsonb,
	"type_parameters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"type_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"doc_comment" jsonb,
	"deprecated" jsonb,
	"modifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decorators" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"edges" jsonb NOT NULL,
	"http_binding" jsonb,
	"parent_id" text,
	"source_path" text NOT NULL,
	"source_start_line" integer NOT NULL,
	"source_end_line" integer NOT NULL,
	"commit_sha" text NOT NULL,
	"analysis_depth" "analysis_depth" NOT NULL,
	"sensitivity" "sensitivity_tier" DEFAULT 'internal' NOT NULL,
	"generated" boolean DEFAULT false NOT NULL,
	"source_text" text,
	"written_by_ir_version" text NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "versions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"ref" text NOT NULL,
	"kind" text NOT NULL,
	"commit_sha" text NOT NULL,
	"committed_at" timestamp with time zone,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"module_id" text NOT NULL,
	"project_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version_id" text NOT NULL,
	"symbol_id" text,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"corpus" text DEFAULT 'code' NOT NULL,
	"content" text NOT NULL,
	"context_header" text,
	"content_hash" text NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"simhash" text,
	"duplicate_cluster_id" text,
	"is_cluster_representative" boolean DEFAULT true NOT NULL,
	"generated" boolean DEFAULT false NOT NULL,
	"sensitivity" "sensitivity_tier" DEFAULT 'internal' NOT NULL,
	"analysis_depth" text DEFAULT 'shallow' NOT NULL,
	"source_path" text,
	"source_start_line" integer,
	"source_end_line" integer,
	"indexed_commit_sha" text NOT NULL,
	"retrieval_config_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_blurbs" (
	"org_id" text NOT NULL,
	"signature_hash" text NOT NULL,
	"module_id" text NOT NULL,
	"blurb" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"repo_id" text,
	"module_id" text,
	"version_id" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"doc_type" text NOT NULL,
	"repo_path" text,
	"provenance_symbol_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provenance_signature_hashes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"sensitivity" "sensitivity_tier" DEFAULT 'internal' NOT NULL,
	"owner_team" text,
	"last_verified_at" timestamp with time zone,
	"last_verified_by" text,
	"generated_by_model" text,
	"generated_by_provider" text,
	"generated_in_region" text,
	"generated_at" timestamp with time zone,
	"status" text DEFAULT 'draft' NOT NULL,
	"staleness_score" real DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embedding_cache" (
	"content_hash" text NOT NULL,
	"model" text NOT NULL,
	"org_id" text NOT NULL,
	"embedding" halfvec(1536),
	"hits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embeddings" (
	"chunk_id" text NOT NULL,
	"org_id" text NOT NULL,
	"module_id" text NOT NULL,
	"version_id" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"embedding" halfvec(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_breadth" (
	"org_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"distinct_repos" integer DEFAULT 0 NOT NULL,
	"distinct_modules" integer DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"surface" text NOT NULL,
	"alerted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"previous_hash" text,
	"hash" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_subject" text,
	"action" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"outcome" text DEFAULT 'success' NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"repos_touched" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"chunk_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trace_id" text,
	"llm_trace_id" text,
	"source_ip" text,
	"user_agent" text,
	"shipped_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dead_letters" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"queue" text NOT NULL,
	"job_name" text NOT NULL,
	"payload_ref" text,
	"payload_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer NOT NULL,
	"last_error" text NOT NULL,
	"first_failed_at" timestamp with time zone NOT NULL,
	"last_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replayed_at" timestamp with time zone,
	"replayed_by" text
);
--> statement-breakpoint
CREATE TABLE "erasure_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_identifier" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_by" timestamp with time zone NOT NULL,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "eval_items" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"question" text NOT NULL,
	"intent_class" text NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expected_symbol_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_chunk_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_answer" text,
	"unanswerable" boolean DEFAULT false NOT NULL,
	"prior_turns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quarantined" boolean DEFAULT false NOT NULL,
	"quarantine_reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"retrieval_config_version" text NOT NULL,
	"config_snapshot" jsonb NOT NULL,
	"git_sha" text,
	"metrics" jsonb NOT NULL,
	"item_count" integer NOT NULL,
	"shadow" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"query_trace_id" text NOT NULL,
	"principal_id" text,
	"signal" text NOT NULL,
	"triage" text,
	"comment" text,
	"implicit" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "module_locks" (
	"module_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"locked_by" text NOT NULL,
	"job_id" text,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "query_traces" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"principal_id" text,
	"session_id" text,
	"surface" text NOT NULL,
	"raw_query" text NOT NULL,
	"rewritten_query" text,
	"intent_class" text,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dense_candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lexical_candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"symbol_candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fused_candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reranked_candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"served_chunk_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expansion_chunk_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stage_timings_ms" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stage_tokens" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"top_rerank_score" real,
	"abstained" boolean DEFAULT false NOT NULL,
	"abstention_reason" text,
	"degraded_modes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"prompt_version" text,
	"embedding_model" text,
	"retrieval_config_version" text NOT NULL,
	"trace_id" text,
	"llm_trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" text,
	"project_id" text,
	"workload" text NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"region" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_usd" real DEFAULT 0 NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"name" text NOT NULL,
	"last_four_chars" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mcp_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"audience" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inferred_project_id" text,
	"client_id" text,
	"client_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"requires_pkce" text DEFAULT 'S256' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"partner_name" text NOT NULL,
	"key_hash" text NOT NULL,
	"pinned_version_id" text,
	"requests_per_hour" text DEFAULT '1000' NOT NULL,
	"contact_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "principal_roles" (
	"principal_id" text NOT NULL,
	"org_id" text NOT NULL,
	"role" text NOT NULL,
	"granted_by" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principal_roles_principal_id_role_pk" PRIMARY KEY("principal_id","role")
);
--> statement-breakpoint
ALTER TABLE "module_projects" ADD CONSTRAINT "module_projects_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_projects" ADD CONSTRAINT "module_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modules" ADD CONSTRAINT "modules_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modules" ADD CONSTRAINT "modules_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principals" ADD CONSTRAINT "principals_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_permissions" ADD CONSTRAINT "repo_permissions_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_permissions" ADD CONSTRAINT "repo_permissions_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "symbols" ADD CONSTRAINT "symbols_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "symbols" ADD CONSTRAINT "symbols_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal_roles" ADD CONSTRAINT "principal_roles_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal_roles" ADD CONSTRAINT "principal_roles_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "module_projects_project_idx" ON "module_projects" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "modules_org_key_idx" ON "modules" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "modules_repo_idx" ON "modules" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "modules_sensitivity_idx" ON "modules" USING btree ("org_id","sensitivity");--> statement-breakpoint
CREATE INDEX "permission_revocations_lookup_idx" ON "permission_revocations" USING btree ("org_id","principal_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "principals_org_subject_idx" ON "principals" USING btree ("org_id","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_org_slug_idx" ON "projects" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "repo_permissions_repo_idx" ON "repo_permissions" USING btree ("repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repos_org_remote_idx" ON "repos" USING btree ("org_id","remote");--> statement-breakpoint
CREATE INDEX "repos_stale_idx" ON "repos" USING btree ("org_id","last_indexed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "api_specs_identity_idx" ON "api_specs" USING btree ("org_id","spec_id","spec_version","version_id");--> statement-breakpoint
CREATE INDEX "api_specs_module_idx" ON "api_specs" USING btree ("module_id");--> statement-breakpoint
CREATE INDEX "cross_repo_edges_from_idx" ON "cross_repo_edges" USING btree ("org_id","from_symbol_id");--> statement-breakpoint
CREATE INDEX "cross_repo_edges_to_idx" ON "cross_repo_edges" USING btree ("org_id","to_symbol_id");--> statement-breakpoint
CREATE INDEX "cross_repo_edges_project_idx" ON "cross_repo_edges" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "cross_repo_edges_unique_idx" ON "cross_repo_edges" USING btree ("from_symbol_id","to_symbol_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "ir_bundles_nonce_idx" ON "ir_bundles" USING btree ("org_id","nonce");--> statement-breakpoint
CREATE UNIQUE INDEX "ir_bundles_commit_idx" ON "ir_bundles" USING btree ("org_id","repo_id","commit_sha","payload_hash");--> statement-breakpoint
CREATE INDEX "ir_bundles_repo_idx" ON "ir_bundles" USING btree ("repo_id","received_at");--> statement-breakpoint
CREATE INDEX "services_org_name_idx" ON "services" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "symbol_aliases_current_idx" ON "symbol_aliases" USING btree ("current_id");--> statement-breakpoint
CREATE INDEX "symbols_scope_idx" ON "symbols" USING btree ("org_id","module_id","version_id");--> statement-breakpoint
CREATE INDEX "symbols_name_idx" ON "symbols" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "symbols_qualified_name_idx" ON "symbols" USING btree ("org_id","qualified_name");--> statement-breakpoint
CREATE INDEX "symbols_signature_hash_idx" ON "symbols" USING btree ("signature_hash");--> statement-breakpoint
CREATE INDEX "symbols_repo_version_idx" ON "symbols" USING btree ("repo_id","version_id");--> statement-breakpoint
CREATE INDEX "symbols_written_by_idx" ON "symbols" USING btree ("written_by_ir_version");--> statement-breakpoint
CREATE UNIQUE INDEX "versions_repo_ref_sha_idx" ON "versions" USING btree ("repo_id","ref","commit_sha");--> statement-breakpoint
CREATE INDEX "versions_default_idx" ON "versions" USING btree ("repo_id","is_default");--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_identity_idx" ON "chunks" USING btree ("org_id","symbol_id","ordinal","version_id");--> statement-breakpoint
CREATE INDEX "chunks_scope_idx" ON "chunks" USING btree ("org_id","module_id","version_id");--> statement-breakpoint
CREATE INDEX "chunks_repo_idx" ON "chunks" USING btree ("repo_id","version_id");--> statement-breakpoint
CREATE INDEX "chunks_corpus_idx" ON "chunks" USING btree ("org_id","corpus","sensitivity");--> statement-breakpoint
CREATE INDEX "chunks_sweep_idx" ON "chunks" USING btree ("module_id","indexed_commit_sha");--> statement-breakpoint
CREATE INDEX "chunks_cluster_idx" ON "chunks" USING btree ("duplicate_cluster_id");--> statement-breakpoint
CREATE INDEX "chunks_config_version_idx" ON "chunks" USING btree ("retrieval_config_version");--> statement-breakpoint
CREATE UNIQUE INDEX "context_blurbs_identity_idx" ON "context_blurbs" USING btree ("org_id","signature_hash","prompt_version");--> statement-breakpoint
CREATE INDEX "context_blurbs_module_idx" ON "context_blurbs" USING btree ("module_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_slug_idx" ON "documents" USING btree ("org_id","slug","version_id");--> statement-breakpoint
CREATE INDEX "documents_scope_idx" ON "documents" USING btree ("org_id","project_id","visibility");--> statement-breakpoint
CREATE INDEX "documents_staleness_idx" ON "documents" USING btree ("org_id","staleness_score");--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_cache_identity_idx" ON "embedding_cache" USING btree ("org_id","content_hash","model");--> statement-breakpoint
CREATE UNIQUE INDEX "embeddings_identity_idx" ON "embeddings" USING btree ("chunk_id","model");--> statement-breakpoint
CREATE INDEX "embeddings_scope_idx" ON "embeddings" USING btree ("org_id","model","module_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_breadth_identity_idx" ON "access_breadth" USING btree ("org_id","principal_id","window_start","surface");--> statement-breakpoint
CREATE INDEX "access_breadth_alert_idx" ON "access_breadth" USING btree ("org_id","window_start","alerted");--> statement-breakpoint
CREATE INDEX "audit_events_org_time_idx" ON "audit_events" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("org_id","actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_action_idx" ON "audit_events" USING btree ("org_id","action","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_unshipped_idx" ON "audit_events" USING btree ("shipped_at");--> statement-breakpoint
CREATE INDEX "dead_letters_queue_idx" ON "dead_letters" USING btree ("queue","last_failed_at");--> statement-breakpoint
CREATE INDEX "dead_letters_unreplayed_idx" ON "dead_letters" USING btree ("org_id","replayed_at");--> statement-breakpoint
CREATE INDEX "erasure_requests_status_idx" ON "erasure_requests" USING btree ("org_id","status","due_by");--> statement-breakpoint
CREATE INDEX "eval_items_stratum_idx" ON "eval_items" USING btree ("org_id","intent_class","quarantined");--> statement-breakpoint
CREATE INDEX "eval_runs_config_idx" ON "eval_runs" USING btree ("org_id","retrieval_config_version","created_at");--> statement-breakpoint
CREATE INDEX "feedback_org_time_idx" ON "feedback" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_triage_idx" ON "feedback" USING btree ("org_id","triage");--> statement-breakpoint
CREATE INDEX "feedback_trace_idx" ON "feedback" USING btree ("query_trace_id");--> statement-breakpoint
CREATE INDEX "module_locks_expiry_idx" ON "module_locks" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "query_traces_org_time_idx" ON "query_traces" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "query_traces_config_idx" ON "query_traces" USING btree ("retrieval_config_version","created_at");--> statement-breakpoint
CREATE INDEX "query_traces_session_idx" ON "query_traces" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "spend_ledger_org_time_idx" ON "spend_ledger" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX "spend_ledger_repo_idx" ON "spend_ledger" USING btree ("repo_id","occurred_at");--> statement-breakpoint
CREATE INDEX "spend_ledger_workload_idx" ON "spend_ledger" USING btree ("org_id","workload","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_hash_idx" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "api_tokens_principal_idx" ON "api_tokens" USING btree ("principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_tokens_hash_idx" ON "mcp_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "mcp_tokens_principal_idx" ON "mcp_tokens" USING btree ("principal_id","revoked_at");--> statement-breakpoint
CREATE INDEX "mcp_tokens_expiry_idx" ON "mcp_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_clients_org_status_idx" ON "oauth_clients" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_keys_hash_idx" ON "partner_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "partner_keys_org_idx" ON "partner_keys" USING btree ("org_id","revoked_at");--> statement-breakpoint
CREATE INDEX "principal_roles_org_idx" ON "principal_roles" USING btree ("org_id");