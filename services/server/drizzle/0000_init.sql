CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stream_session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"t_start" real NOT NULL,
	"t_end" real NOT NULL,
	"gate" jsonb,
	"tokens" jsonb,
	"prompt" text,
	"event" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stream_session_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"gpu_index" integer NOT NULL,
	"host" text NOT NULL,
	"status" text DEFAULT 'healthy' NOT NULL,
	"capacity" integer NOT NULL,
	"slots_used" integer DEFAULT 0 NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stream_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source" text NOT NULL,
	"runner_id" uuid,
	"session_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stream_session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"t_start" real NOT NULL,
	"t_end" real NOT NULL,
	"p_speak" real,
	"decision" text,
	"tokens_visual" integer,
	"tokens_baseline_dense" integer,
	"tokens_generated" integer,
	"prompt" text,
	"response_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_stream_session_id_stream_sessions_id_fk" FOREIGN KEY ("stream_session_id") REFERENCES "public"."stream_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_stream_session_id_stream_sessions_id_fk" FOREIGN KEY ("stream_session_id") REFERENCES "public"."stream_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_sessions" ADD CONSTRAINT "stream_sessions_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_sessions" ADD CONSTRAINT "stream_sessions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_stream_session_id_stream_sessions_id_fk" FOREIGN KEY ("stream_session_id") REFERENCES "public"."stream_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_session_idx" ON "events" USING btree ("stream_session_id");--> statement-breakpoint
CREATE INDEX "events_session_seq_idx" ON "events" USING btree ("stream_session_id","seq");--> statement-breakpoint
CREATE INDEX "prompts_stream_session_idx" ON "prompts" USING btree ("stream_session_id");--> statement-breakpoint
CREATE INDEX "runners_gpu_index_idx" ON "runners" USING btree ("gpu_index");--> statement-breakpoint
CREATE INDEX "stream_sessions_runner_idx" ON "stream_sessions" USING btree ("runner_id");--> statement-breakpoint
CREATE INDEX "stream_sessions_status_idx" ON "stream_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "token_ledger_session_idx" ON "token_ledger" USING btree ("stream_session_id");--> statement-breakpoint
CREATE INDEX "token_ledger_session_seq_idx" ON "token_ledger" USING btree ("stream_session_id","seq");