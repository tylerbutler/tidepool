import gleam/dict
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import spillway/connect_document
import spillway/message
import spillway/sequencing
import spillway/session_logic
import spillway/signals
import spillway/socketio
import spillway/types
import spillway/validation

fn finish(value: Result(Json, String)) -> String {
  case value {
    Ok(value) -> json.object([#("ok", value)])
    Error(reason) -> json.object([#("error", json.string(reason))])
  }
  |> json.to_string
}

fn json_value() -> decode.Decoder(Json) {
  use raw <- decode.then(decode.dynamic)
  case decode.run(raw, decode.string) {
    Ok(value) -> decode.success(json.string(value))
    Error(_) ->
      case decode.run(raw, decode.bool) {
        Ok(value) -> decode.success(json.bool(value))
        Error(_) ->
          case decode.run(raw, decode.float) {
            Ok(value) -> decode.success(json.float(value))
            Error(_) ->
              case decode.run(raw, decode.list(decode.dynamic)) {
                Ok(_) ->
                  decode.map(decode.list(json_value()), json.preprocessed_array)
                Error(_) ->
                  case
                    decode.run(raw, decode.dict(decode.string, decode.dynamic))
                  {
                    Ok(_) ->
                      decode.map(
                        decode.dict(decode.string, json_value()),
                        json.dict(_, fn(k) { k }, fn(v) { v }),
                      )
                    Error(_) ->
                      decode.map(decode.optional(decode.string), fn(_) {
                        json.null()
                      })
                  }
              }
          }
      }
  }
}

pub fn admit(input: String, scopes: String) -> String {
  let outcome = {
    use raw <- result.try(
      json.parse(input, decode.dynamic)
      |> result.replace_error("Malformed connect payload"),
    )
    use request <- result.try(
      connect_document.parse_request(raw)
      |> result.replace_error("Invalid connect payload"),
    )
    use scopes <- result.try(
      json.parse(scopes, decode.list(types.scope_decoder()))
      |> result.replace_error("Invalid scopes"),
    )
    use Nil <- result.try(
      connect_document.validate_mode_scope(request.mode, scopes)
      |> result.replace_error("Write scope required"),
    )
    let mode = case request.mode {
      Some(types.WriteMode) -> "write"
      _ -> "read"
    }
    Ok(
      json.object([
        #("tenantId", json.string(request.tenant_id)),
        #("documentId", json.string(request.document_id)),
        #("token", json.string(request.token)),
        #("mode", json.string(mode)),
      ]),
    )
  }
  finish(outcome)
}

fn client_decoder() -> decode.Decoder(#(String, sequencing.ClientSequenceState)) {
  use id <- decode.field("id", decode.string)
  use csn <- decode.field("csn", decode.int)
  use rsn <- decode.field("rsn", decode.int)
  decode.success(#(id, sequencing.ClientSequenceState(csn, rsn)))
}

fn state_decoder() -> decode.Decoder(sequencing.SequenceState) {
  use sn <- decode.field("sn", decode.int)
  use msn <- decode.field("msn", decode.int)
  use clients <- decode.field("clients", decode.list(client_decoder()))
  decode.success(sequencing.SequenceState(sn, msn, dict.from_list(clients)))
}

type Submitted {
  Submitted(
    csn: Int,
    rsn: Int,
    kind: String,
    contents: Json,
    metadata: Json,
    compression: option.Option(Json),
    traces: option.Option(Json),
  )
}

fn op_decoder() -> decode.Decoder(Submitted) {
  use csn <- decode.field("clientSequenceNumber", decode.int)
  use rsn <- decode.field("referenceSequenceNumber", decode.int)
  use kind <- decode.field("type", decode.string)
  use contents <- decode.optional_field("contents", json.null(), json_value())
  use metadata <- decode.optional_field("metadata", json.null(), json_value())
  use compression <- decode.optional_field(
    "compression",
    None,
    decode.map(decode.string, fn(value) { Some(json.string(value)) }),
  )
  use traces <- decode.optional_field(
    "traces",
    None,
    decode.map(decode.list(json_value()), fn(value) {
      Some(json.preprocessed_array(value))
    }),
  )
  decode.success(Submitted(
    csn,
    rsn,
    kind,
    contents,
    metadata,
    compression,
    traces,
  ))
}

fn proposal_decoder() -> decode.Decoder(#(String, Json)) {
  use key <- decode.field("key", decode.string)
  use value <- decode.field("value", json_value())
  decode.success(#(key, value))
}

fn proposal(contents: String) -> Result(#(String, Json), String) {
  let contents = case json.parse(contents, decode.string) {
    Ok(encoded) -> encoded
    Error(_) -> contents
  }
  json.parse(contents, proposal_decoder())
  |> result.replace_error("Malformed quorum proposal")
}

pub opaque type Quorum {
  Quorum(
    sequence: Int,
    minimum: Int,
    proposals: dict.Dict(Int, #(String, Json)),
    values: dict.Dict(String, Json),
  )
}

pub fn quorum_new(values: String, sequence: Int) -> Result(Quorum, String) {
  let decoder = {
    use key <- decode.then(decode.at([0], decode.string))
    use value <- decode.then(decode.at([1], json_value()))
    decode.success(#(key, value))
  }
  use values <- result.try(
    json.parse(values, decode.list(decoder))
    |> result.replace_error("Invalid initial quorum values"),
  )
  Ok(Quorum(sequence, sequence, dict.new(), dict.from_list(values)))
}

pub fn quorum_step(
  state: Quorum,
  sequence: Int,
  minimum: Int,
  kind: String,
  contents: String,
) -> Result(Quorum, String) {
  use Nil <- result.try(
    case
      sequence == state.sequence + 1
      && minimum >= state.minimum
      && minimum <= sequence
    {
      True -> Ok(Nil)
      False -> Error("Invalid protocol replay sequence")
    },
  )
  use pending <- result.try(case kind {
    "propose" ->
      proposal(contents)
      |> result.map(dict.insert(state.proposals, sequence, _))
    _ -> Ok(state.proposals)
  })
  let #(pending, values) = case minimum > state.minimum {
    False -> #(pending, state.values)
    True ->
      pending
      |> dict.to_list
      |> list.filter(fn(pair) { pair.0 <= minimum })
      |> list.sort(fn(a, b) { int.compare(a.0, b.0) })
      |> list.fold(#(pending, state.values), fn(acc, pair) {
        let #(pending, values) = acc
        let #(sn, #(key, value)) = pair
        let approved =
          json.object([
            #("key", json.string(key)),
            #("value", value),
            #("sequenceNumber", json.int(sn)),
            #("approvalSequenceNumber", json.int(sequence)),
            #("commitSequenceNumber", json.int(-1)),
          ])
        #(dict.delete(pending, sn), dict.insert(values, key, approved))
      })
  }
  Ok(Quorum(sequence, minimum, pending, values))
}

pub fn quorum_snapshot(state: Quorum) -> String {
  json.object([
    #("sequenceNumber", json.int(state.sequence)),
    #("minimumSequenceNumber", json.int(state.minimum)),
    #(
      "proposals",
      state.proposals
        |> dict.to_list
        |> list.sort(fn(a, b) { int.compare(a.0, b.0) })
        |> json.array(fn(pair) {
          let #(sn, #(key, value)) = pair
          json.preprocessed_array([
            json.int(sn),
            json.object([
              #("sequenceNumber", json.int(sn)),
              #("key", json.string(key)),
              #("value", value),
            ]),
            json.preprocessed_array([]),
          ])
        }),
    ),
    #(
      "values",
      json.array(dict.to_list(state.values), fn(pair) {
        json.preprocessed_array([json.string(pair.0), pair.1])
      }),
    ),
  ])
  |> json.to_string
}

pub fn assign(
  checkpoint: String,
  client: String,
  mode: String,
  input: String,
  size: Int,
  timestamp: Int,
) -> String {
  let outcome = {
    use state <- result.try(
      json.parse(checkpoint, state_decoder())
      |> result.replace_error("Corrupt checkpoint"),
    )
    use op <- result.try(
      json.parse(input, op_decoder())
      |> result.replace_error("Malformed operation"),
    )
    use Nil <- result.try(case op.csn > 0 && op.rsn >= 0 && mode == "write" {
      True -> Ok(Nil)
      False -> Error("Invalid sequence number or read-only client")
    })
    use _ <- result.try(
      message.message_type_from_string(op.kind)
      |> result.replace_error("Unknown operation type"),
    )
    use Nil <- result.try(
      case
        list.contains(
          ["op", "noop", "summarize", "propose", "accept", "reject"],
          op.kind,
        )
      {
        True -> Ok(Nil)
        False -> Error("Server-only operation type")
      },
    )
    use Nil <- result.try(
      validation.validate_message_size(size, 1_048_576)
      |> result.map_error(validation.format_error),
    )
    use Nil <- result.try(case op.kind {
      "propose" ->
        proposal(json.to_string(op.contents)) |> result.map(fn(_) { Nil })
      _ -> Ok(Nil)
    })
    use assigned <- result.try(
      sequencing.assign_sequence_number(state, client, op.csn, op.rsn)
      |> result.replace_error("Invalid client or reference sequence number"),
    )
    let sequenced =
      session_logic.build_sequenced_op(session_logic.SequencedOpParams(
        client_id: client,
        sequence_number: assigned.assigned_sn,
        minimum_sequence_number: assigned.msn,
        client_sequence_number: op.csn,
        reference_sequence_number: op.rsn,
        op_type: op.kind,
        contents: op.contents,
        metadata: op.metadata,
        timestamp: timestamp,
      ))
    use fields <- result.try(
      json.parse(
        json.to_string(sequenced),
        decode.dict(decode.string, json_value()),
      )
      |> result.replace_error("Invalid generated operation"),
    )
    let extra =
      [
        #("compression", op.compression),
        #("traces", op.traces),
      ]
      |> list.filter_map(fn(pair) {
        let #(key, value) = pair
        option.to_result(value, Nil)
        |> result.map(fn(value) { #(key, value) })
      })
    Ok(json.object(list.append(dict.to_list(fields), extra)))
  }
  finish(outcome)
}

pub fn system(
  checkpoint: String,
  kind: String,
  data: String,
  timestamp: Int,
) -> String {
  let outcome = {
    use state <- result.try(
      json.parse(checkpoint, state_decoder())
      |> result.replace_error("Corrupt checkpoint"),
    )
    let #(state, sn) = sequencing.reserve_sequence_number(state)
    Ok(
      json.object([
        #("clientId", json.null()),
        #("clientSequenceNumber", json.int(-1)),
        #("referenceSequenceNumber", json.int(-1)),
        #("sequenceNumber", json.int(sn)),
        #("minimumSequenceNumber", json.int(state.minimum_sequence_number)),
        #("type", json.string(kind)),
        #("contents", json.null()),
        #("data", json.string(data)),
        #("timestamp", json.int(timestamp)),
      ]),
    )
  }
  finish(outcome)
}

pub fn summary_response(
  handle: String,
  proposal: Int,
  minimum: Int,
  timestamp: Int,
) -> String {
  session_logic.build_summary_ack(handle, proposal, minimum, timestamp)
  |> json.to_string
}

pub fn frame(input: String) -> String {
  let outcome = case input {
    "1" | "41" -> Ok(json.object([#("event", json.string("socketDisconnect"))]))
    _ -> classify(input)
  }
  finish(outcome)
}

fn classify(input: String) -> Result(Json, String) {
  case socketio.classify(input) {
    socketio.EnginePing ->
      Ok(json.object([#("event", json.string("enginePing"))]))
    socketio.EnginePong ->
      Ok(json.object([#("event", json.string("enginePong"))]))
    socketio.SocketConnect ->
      Ok(json.object([#("event", json.string("socketConnect"))]))
    socketio.FluidEvent(event, args) -> {
      use args <- result.try(
        list.try_map(args, fn(arg: Dynamic) {
          decode.run(arg, json_value())
          |> result.replace_error("Invalid event arguments")
        }),
      )
      Ok(
        json.object([
          #("event", json.string(event)),
          #("args", json.preprocessed_array(args)),
        ]),
      )
    }
    socketio.Unrecognized(reason) -> Error(reason)
  }
}

pub fn open(sid: String) -> String {
  socketio.encode_open(sid, 10_000, 20_000, 1_048_576)
}

pub fn signal_batch(input: String, sender: String, clients: String) -> String {
  let outcome = {
    use clients <- result.try(
      json.parse(clients, decode.list(decode.string))
      |> result.replace_error("Invalid roster"),
    )
    use batch <- result.try(
      signals.parse_batch(input, json_value())
      |> result.replace_error("Malformed signal batch"),
    )
    Ok(
      json.array(batch, fn(signal) {
        let recipients = case
          signal.target_client_id,
          signal.targeted_clients,
          signal.ignored_clients
        {
          None, None, None -> clients
          Some(id), _, _ if id == sender -> [sender]
          _, _, _ ->
            session_logic.determine_signal_recipients(
              sender,
              signal.targeted_clients,
              signal.ignored_clients,
              signal.target_client_id,
              clients,
            )
        }
        json.object([
          #("recipients", json.array(recipients, json.string)),
          #(
            "message",
            json.object([
              #("clientId", json.string(sender)),
              #("content", signal.content),
              #(
                "targetClientId",
                json.nullable(signal.target_client_id, json.string),
              ),
            ]),
          ),
        ])
      }),
    )
  }
  finish(outcome)
}
