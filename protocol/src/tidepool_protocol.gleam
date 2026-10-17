import gleam/dynamic
import gleam/dynamic/decode
import gleam/json
import gleam/option.{None, Some}
import spillway/connect_document
import spillway/sequencing
import spillway/session_logic
import spillway/signals
import spillway/socketio
import spillway/summary
import spillway/types
import spillway/validation

pub fn main() -> Nil {
  let state =
    sequencing.new()
    |> sequencing.client_join("writer", 0)
  let assert Ok(sequencing.SequenceAssignment(state, 1, 0)) =
    sequencing.assign_sequence_number(state, "writer", 1, 0)
  let assert Error(sequencing.InvalidCsn(1, 1)) =
    sequencing.assign_sequence_number(state, "writer", 1, 0)
  let assert Ok(Nil) = validation.validate_message_size(1_048_576, 1_048_576)
  let assert Error(_) = validation.validate_message_size(1_048_577, 1_048_576)

  let assert Ok(payload) =
    json.parse(
      "{\"tenantId\":\"fluid\",\"id\":\"document\",\"token\":\"test-token\",\"mode\":\"write\"}",
      decode.dynamic,
    )
  let assert Ok(request) = connect_document.parse_request(payload)
  let assert Some(types.WriteMode) = request.mode
  let assert Ok(read) = types.scope_from_string("doc:read")
  let assert Ok(write) = types.scope_from_string("doc:write")
  let assert Ok(Nil) =
    connect_document.validate_mode_scope(request.mode, [read, write])
  let assert Error(_) =
    connect_document.validate_mode_scope(request.mode, [read])

  let frame = socketio.encode_connect_document_success(json.object([]))
  let assert socketio.FluidEvent("connect_document_success", [_]) =
    socketio.classify(frame)

  let op =
    session_logic.build_sequenced_op(session_logic.SequencedOpParams(
      client_id: "writer",
      sequence_number: 1,
      minimum_sequence_number: 0,
      client_sequence_number: 1,
      reference_sequence_number: 0,
      op_type: "op",
      contents: json.string("edit"),
      metadata: json.null(),
      timestamp: 1,
    ))
    |> json.to_string
  let assert Ok(1) = json.parse(op, decode.at(["sequenceNumber"], decode.int))

  let assert Ok(signal) = json.parse("{\"content\":\"signal\"}", decode.dynamic)
  let assert Ok(signals.NormalizedSignal(
    content: "signal",
    target_client_id: None,
    ..,
  )) = signals.normalize_signal(signal, decode.string)
  let assert Error(_) = signals.normalize_signal(dynamic.nil(), decode.string)

  let ack = summary.create_summary_ack("summary", 1)
  let assert 1 = ack.summary_sequence_number
  let wire_ack =
    session_logic.build_summary_ack("summary", 1, 0, 1) |> json.to_string
  let assert Ok(2) =
    json.parse(wire_ack, decode.at(["sequenceNumber"], decode.int))
  Nil
}
