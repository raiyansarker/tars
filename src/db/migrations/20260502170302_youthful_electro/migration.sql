CREATE TABLE `channel_subscriptions` (
	`id` text PRIMARY KEY,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL UNIQUE,
	`guild_name` text,
	`channel_name` text,
	`timezone` text NOT NULL,
	`delivery_hour` integer NOT NULL,
	`delivery_minute` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by_user_id` text NOT NULL,
	`mention_role_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `command_channels` (
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	CONSTRAINT `command_channels_pk` PRIMARY KEY(`guild_id`, `channel_id`)
);
--> statement-breakpoint
CREATE TABLE `rating_snapshots` (
	`id` text PRIMARY KEY,
	`tracked_handle_id` text NOT NULL,
	`rating` integer,
	`rank_label` text,
	`max_rating` integer,
	`is_improvement` integer DEFAULT false NOT NULL,
	`captured_at` text NOT NULL,
	`raw_payload_json` text NOT NULL,
	CONSTRAINT `fk_rating_snapshots_tracked_handle_id_tracked_handles_id_fk` FOREIGN KEY (`tracked_handle_id`) REFERENCES `tracked_handles`(`id`)
);
--> statement-breakpoint
CREATE TABLE `tracked_handles` (
	`id` text PRIMARY KEY,
	`guild_id` text NOT NULL,
	`platform` text NOT NULL,
	`handle` text NOT NULL,
	`handle_normalized` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_channel_subscriptions_guild` ON `channel_subscriptions` (`guild_id`);--> statement-breakpoint
CREATE INDEX `idx_rating_snapshots_handle` ON `rating_snapshots` (`tracked_handle_id`);--> statement-breakpoint
CREATE INDEX `idx_tracked_handles_guild` ON `tracked_handles` (`guild_id`);