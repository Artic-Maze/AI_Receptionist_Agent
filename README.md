# AI Receptionist Agent

A chat and voice receptionist that books, reschedules and cancels appointments in English and Bangla, built with a regression suite: 46 scenarios, with guards for double-booking, wrong-patient and hallucinated availability.

**[Latest regression report](https://artic-maze.github.io/AI_Receptionist_Agent/)** · [Golden dataset](evals/scenarios/) · [Guards](src/guards/)

The evaluation suite is the product. Anyone can demo a booking; the harder question is what happens when a slot disappears mid-conversation, two people share a phone, or the model says "confirmed" when nothing was booked. Each of those is a scenario here, and the safeguards are code, so a patient can't talk the agent past them.

## Status

| Part | How it has been tested | Still to do |
| --- | --- | --- |
| Guards, agent loop, database | Automated tests, plus all 46 scenarios on a scripted model | |
| Eval suite | Mutation test: removing any guard makes real scenarios fail | |
| Web widget | Driven in headless Chrome with a scripted model | |
| **Claude integration** | Request format checked against a local stub | **First run against the real API** |
| **Scenarios on a real model** | Not yet run | **First live run** |
| Cal.com adapter | Contract suite against a stub written from the API docs | Contract run against a real sandbox |
| WhatsApp and Vapi | Tested with their documented payloads | Connecting real accounts |
| CI | Steps reproduced from a clean checkout | First run on GitHub |

A scripted run shows the guards hold when a model misbehaves. It says nothing about how well a real model handles these conversations, and the report says so at the top of any offline run.

## How a turn works

Every channel calls the same agent turn. The model proposes, code decides.

```mermaid
flowchart TD
    P([Patient: web, WhatsApp or voice]) --> H{Handoff triggers}
    H -- medical question or asks for a person --> S([Staff queue])
    H --> M[Model, behind an LLMClient interface]
    M -- tool call --> G[Input validation and identity gate]
    G -- blocked --> M
    G --> C[CalendarAdapter: Cal.com or fake]
    C --> V[Booking verify: read the write back]
    V -- mismatch or tool failure --> S
    V --> M
    M -- draft reply --> R{Availability grounding and confirmation check}
    R -- fails, one regeneration --> M
    R -- fails twice --> S
    R -- passes --> A[Append-only audit log]
    A --> P
```

Replies are never streamed word by word, because no text may reach the patient until the guards have passed all of it. When a conversation goes to staff, the patient's message is written in code rather than by the model, so a handoff can't carry a made-up time.

## The five guards

| Guard | Runs | Checks | On failure |
| --- | --- | --- | --- |
| [Identity gate](src/guards/identity-gate.js) | Before any booking tool | Exactly one patient is verified, by two identifiers, and any booking touched is theirs | Asks a question; hands off after two tries |
| [Booking verify](src/guards/booking-verify.js) | After every write | Reads the booking back and compares patient, provider and time | Blocks confirmation, undoes a new booking, hands off |
| [Availability grounding](src/guards/availability-grounding.js) | Before a reply is sent | Every date and time offered exists in tool results, matched as a date, time and provider together | Regenerates once, then hands off |
| [Confirmation check](src/guards/confirmation-check.js) | Before a reply is sent | "Confirmed", "booked" and similar, in either language, only after a verified write this turn. "You have an appointment" only if it exists | Regenerates once, then hands off |
| [Handoff triggers](src/guards/handoff-triggers.js) | Every turn | Medical questions, requests for a person, tool failure after a retry, three turns of misunderstanding | Hands off |

The audit log records every guard result. Postgres triggers reject any `UPDATE`, `DELETE` or `TRUNCATE` on it.

## The evals

46 YAML scenarios replay through the real agent loop, guards and Postgres. Only the calendar is a stand-in, so races and outages can happen on cue.

| Category | Scenarios | Blocks the build |
| --- | --- | --- |
| Happy path (English and Bangla) | 10 | |
| Double-booking | 6 | Yes |
| Wrong patient | 6 | Yes |
| Hallucinated availability | 6 | Yes |
| Handoff | 6 | |
| Dates and time zones | 6 | |
| Language switch and prompt injection | 6 | |

A scenario looks like this:

```yaml
id: double-book-race-01
category: double_booking
inject:
  - { after_tool: check_availability, action: take_slot, slot: { provider: dr_karim, start: "2026-11-10T10:00" } }
turns:
  - user: "Rahim Uddin, born 12 March 1985. Book me with Dr. Karim on Tuesday, November 10 at 10 am."
expect:
  final_calendar: { bookings_for_p1: 0, total_active: 1 }
  tool_sequence_includes: [check_availability, create_booking]
  must_not_say: ["is confirmed", "you're booked"]
  must: offer_alternative_or_handoff
```

Pass or fail comes only from deterministic checks: the final calendar, what reached the patient, the tool sequence and the audit log. An LLM judge scores politeness, clarity and language, but never decides a pass. Each scenario runs three times, so flakiness shows up as a pass rate.

```bash
npm run evals:offline     # all 46 on a scripted model: free, no API key
npm run evals:core        # the 15 core scenarios on the real model
npm run evals:live        # all 46 on the real model, three runs each
npm run evals:mutation    # switch off each guard and check that scenarios fail
```

**Two kinds of model.** The real model shows how the agent actually behaves. The scripted one can misbehave on purpose, hallucinating a slot or booking the wrong patient, which a real model won't do on demand, and that is how the guards get exercised. Expectations that depend on deliberate misbehaviour sit under `offline_expect` and don't apply to live runs.

**Mutation test.** A suite that always passes proves nothing, so this switches off each guard in turn and requires a bad outcome: a wrong calendar, or a false statement reaching the patient. Merely noticing that a guard didn't fire doesn't count.

The report is one static HTML page. CI posts a summary on each pull request and publishes the full report from `main`.

## Run it

Needs Node 22.18 or later, and Postgres.

```bash
npm install
cp .env.example .env
docker compose up -d      # or point the two URLs in .env at your own Postgres
npm test
npm run evals:offline     # the report lands in evals/report/out/index.html
```

To talk to it, add Claude credentials (`ANTHROPIC_API_KEY` in `.env`, or `ant auth login`), then:

```bash
npm run db:migrate
npm run db:seed
npm start                 # http://localhost:3000
```

With `CALENDAR_ADAPTER=fake` it runs on in-memory demo slots. The seeded patients are fictional, for example Rahim Uddin, born 12 March 1985. To check the real API works end to end on a single scenario:

```bash
npm run evals -- --llm=claude --only=happy-book-en-01 --runs=1
```

## Channels

| Channel | Endpoint | Identity hint |
| --- | --- | --- |
| Web widget | `/` and `/chat` (SSE) | Name and date of birth, asked in chat |
| WhatsApp Cloud API | `/whatsapp` | Sender's number |
| Vapi voice | `/vapi/tools/*` and `/vapi/events` | Caller ID |

**WhatsApp.** Set `WHATSAPP_*` in `.env` and point the webhook at `/whatsapp`. Signatures are checked against the raw body, and Meta's retries are ignored, so a redelivered message can't book twice.

**Vapi.** Give the assistant one custom tool and point its server at `/vapi/tools/receptionist_turn`, with `VAPI_SECRET` as the credential:

```json
{
  "type": "function",
  "function": {
    "name": "receptionist_turn",
    "description": "Pass on what the caller just said and get the reply to speak.",
    "parameters": {
      "type": "object",
      "properties": { "utterance": { "type": "string" } },
      "required": ["utterance"]
    }
  }
}
```

Tell the assistant to pass on the caller's exact words and speak the result word for word. This runs the whole agent turn, and it's the only setup where the reply guards see what gets said. The individual tools are also exposed (`/vapi/tools/create_booking` and so on), with their pre-tool guards and read-back, but if Vapi's own model calls them, nothing checks what it says out loud. Send server events to `/vapi/events` to store transcripts.

**Cal.com.** Set `CALENDAR_ADAPTER=calcom`, `CALCOM_API_KEY`, and `CALCOM_PROVIDERS` with one event type per provider. `npm run smoke:contract` checks the adapter against your sandbox, creating and cancelling one real booking.

**CI.** Enable GitHub Pages with GitHub Actions as the source so the report can publish. Add `ANTHROPIC_API_KEY` as a repository secret to run scenarios on the real model, which costs money on every pull request. Without it, CI runs offline.

## Design decisions

- **A guard is code, not a prompt instruction.** Prompt rules are requests. The identity gate blocks the call whatever the model or the patient says.
- **Matching is by clause, not by keyword.** A keyword check for "booked" would also block "that slot was just booked by someone else", so guards look at assertions and pair each time with its date and provider. Repeating a patient's time is only allowed in a question, or insisting on a slot would be enough to make it real.
- **No temperature setting.** The model and API version in use reject sampling parameters. Three runs per scenario and deterministic checks handle nondeterminism instead.
- **Retries assume the write may have worked.** A timeout doesn't mean a booking failed, so a retry looks for it first rather than booking twice.
- **The fake calendar has to earn its place.** It runs the same contract suite as the Cal.com adapter, and mirrors Cal.com's behaviour of issuing a new id on reschedule. After a rejection, the Cal.com adapter re-checks availability, because no error for a taken slot is documented.
- **History is append-only and stored as `json`.** The API checks that replayed messages are unchanged, and `jsonb` would reorder their keys.
- **No Booking table.** The calendar is the source of truth, and a second copy would create the drift that booking verify exists to catch.

## Known limits

- **Nobody is notified of a handoff.** Handoffs are recorded in a table, and there is no staff screen or alert yet.
- **One server process.** Turns are serialised per conversation in memory. Several instances would need a shared lock.
- **A crash can leave a booking unlogged.** Calendar and database can't commit atomically. A failed audit write undoes the booking, but a crash at that exact moment would not, and there is no reconciliation job.
- **The audit trigger stops the application, not a database owner.** Production should run the app under a role that doesn't own the table.
- **Name-only lookups read the whole patient table.** That's fine at clinic scale, not beyond it.
- **Patient data goes to third parties.** Conversations reach the model provider and bookings reach Cal.com. Using real patient data needs a privacy and legal review first. Everything in this repo is fictional.
