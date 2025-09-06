create table if not exists webhook_events (
  delivery_id varchar(128) primary key,
  event_type varchar(64),
  payload_json json,
  received_at timestamp default current_timestamp
);

create table if not exists build_failures (
  failure_id bigint primary key auto_increment,
  run_id varchar(128) unique,
  repo_owner varchar(200),
  repo_name varchar(200),
  pr_number int,
  commit_sha varchar(64),
  log_content longtext,
  status enum('new','analyzing','proposed','applied','skipped') default 'new',
  failure_timestamp timestamp default current_timestamp
);

create table if not exists outbound_actions (
  id bigint primary key auto_increment,
  action_hash char(64) unique not null,
  repo_owner varchar(200) not null,
  repo_name varchar(200) not null,
  pull_number int not null,
  head_sha char(40) not null,
  action_type enum('pr_review') not null,
  payload_json json not null,
  dispatched_at timestamp null,
  github_response_json json null
);
