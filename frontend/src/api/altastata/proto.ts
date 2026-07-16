/**
 * Embedded gateway protobuf definitions and typed lookup helpers.
 */
import protobufjs, { type Type } from "protobufjs/dist/protobuf";

export type Bytes = Uint8Array;

const PROTO_DEF = `
syntax = "proto3";
package altastata.v1;

message Empty {}
message User {
  string user_name = 1;
  bool initialized = 2;
  string access_key = 3;
}
message GetMyAccountRequest {}
// Wire-compatible with google.protobuf.Timestamp (same field numbers); we
// inline it because protobufjs.parse() of a single-string proto definition
// cannot resolve cross-package imports.
message Timestamp {
  int64 seconds = 1;
  int32 nanos   = 2;
}
message LoginV2Upload {
  string user_properties = 1;
  map<string, bytes> account_files = 2;
}
message LoginV2Request {
  string client_hint = 1;
  string password = 2;
  LoginV2Upload upload = 3;
}
message LoginV2Response {
  string session_token = 1;
  Timestamp expires_at = 2;
}
message LogoutRequest {}
message LogoutResponse {}
message FileStatus {
  string file_path = 1;
  string operation_state = 2;
  string error = 3;
}
message ListVersionsRequest {
  string cloud_path_prefix = 1;
  bool including_subdirectories = 2;
  string time_interval_start = 3;
  string time_interval_end = 4;
}
message VersionEntry { repeated string versions = 1; }
message CreateFileRequest {
  string file_path = 1;
  bytes content = 2;
}
message CreateFileResponse { FileStatus status = 1; }
message GetBufferRequest {
  string file_path = 1;
  int64 snapshot_time = 2;
  int64 start_position = 3;
  int32 parallel_chunks = 4;
  int32 size = 5;
  bool trust_cached_size = 6;
}
message GetBufferResponse { bytes data = 1; }
message DeleteRequest {
  string cloud_path_prefix = 1;
  bool including_subdirectories = 2;
  string time_interval_start = 3;
  string time_interval_end = 4;
}
message DeleteResponse { repeated FileStatus statuses = 1; }
message ShareRequest {
  repeated string file_paths = 1;
  repeated string readers = 2;
}
message ShareResult { repeated FileStatus statuses = 1; }
message RevokeRequest {
  repeated string file_paths = 1;
  repeated string readers = 2;
}
message RevokeResult { repeated FileStatus statuses = 1; }
message UserSummary {
  string user_name = 1;
  bool initialized = 2;
}
message GetAttributesRequest {
  string file_path = 1;
  int64 snapshot_time = 2;
  repeated string names = 3;
}
message AttributeMap { map<string, string> attributes = 1; }
message ReadStreamRequest {
  string file_path = 1;
  int64 snapshot_time = 2;
  int64 start_position = 3;
  int32 parallel_chunks = 4;
  int32 chunk_size = 5;
}
message ReadStreamChunk { bytes data = 1; }
message DownloadDirectoryAsZipRequest {
  string cloud_path_prefix = 1;
}
message DownloadDirectoryAsZipChunk { bytes data = 1; }
message BeginUploadRequest {
  string cloud_path = 1;
  int64 total_size = 2;
}
message BeginUploadResponse {
  string upload_id = 1;
  int32 chunk_size = 2;
}
message UploadChunkRequest {
  string upload_id = 1;
  int64 offset = 2;
  bytes data = 3;
}
message UploadChunkResponse {
  int64 bytes_received = 1;
}
message CompleteUploadRequest {
  string upload_id = 1;
}
message CompleteUploadResponse { FileStatus status = 1; }
message AbortUploadRequest {
  string upload_id = 1;
}
message AbortUploadResponse { bool aborted = 1; }
message WatchRequest {
  uint64 since_sequence = 1;
}
message FileSharedEvent {
  string file_id   = 1;
  string file_path = 2;
  string shared_by = 3;
}
message FileUnsharedEvent {
  string file_id     = 1;
  string unshared_by = 2;
}
message SessionRevokedEvent {
  enum Reason {
    LOGOUT  = 0;
    EXPIRED = 1;
    ADMIN   = 2;
  }
  Reason reason = 1;
}
message EventGapEvent {
  uint64 server_oldest_sequence = 1;
}
message Event {
  uint64    sequence            = 1;
  Timestamp occurred_at         = 2;
  string    origin_session_hash = 3;
  oneof payload {
    FileSharedEvent     file_shared     = 10;
    FileUnsharedEvent   file_unshared   = 11;
    SessionRevokedEvent session_revoked = 99;
    EventGapEvent       event_gap       = 100;
  }
}
enum AccountType {
  ACCOUNT_TYPE_UNSPECIFIED = 0;
  RSA = 1;
  PQC = 2;
  HPCS = 3;
}
message GetSupportedAccountTypesRequest {}
message GetSupportedAccountTypesResponse {
  repeated AccountType account_types = 1;
}
message GenerateKeysRequest {
  AccountType account_type = 1;
  string password = 2;
  string suggested_display_name = 3;
}
message GenerateKeysResponse {
  map<string, bytes> account_files = 1;
  string suggested_display_name = 2;
}
`;

const root = protobufjs.parse(PROTO_DEF).root;
const typeCache = new Map<string, Type>();

export function T(name: string): Type {
  const cached = typeCache.get(name);
  if (cached) return cached;
  const type = root.lookupType(`altastata.v1.${name}`);
  typeCache.set(name, type);
  return type;
}
