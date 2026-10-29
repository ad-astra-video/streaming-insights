CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"ts" timestamp DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gpu" integer NOT NULL,
	"total_slots" integer NOT NULL,
	"free_slots" integer NOT NULL,
	"healthy" boolean DEFAULT true NOT NULL,
	"last_heartbeat" timestamp
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"runner_id" uuid,
	"prompt" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "stream_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"source" text NOT NULL,
	"video_path" text,
	"started_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"t_start" real NOT NULL,
	"t_end" real NOT NULL,
	"p_speak" real NOT NULL,
	"decision" text NOT NULL,
	"tokens_visual" integer NOT NULL,
	"tokens_baseline_dense" integer NOT NULL,
	"tokens_generated" integer NOT NULL,
	"prompt" text,
	"response_text" text
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_sessions" ADD CONSTRAINT "stream_sessions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prompts_session_idx" ON "prompts" USING btree ("session_id","created_at");