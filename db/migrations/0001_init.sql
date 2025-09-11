create table if not exists webhook_events (
  delivery_id varchar(128) primary key,
  event_type varchar(64),
  payload_json json,
  received_at timestamp default current_timestamp
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
