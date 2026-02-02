
# Agent Architecture Evolution

* TOC
{:toc}

---

## Current Architecture

The current architecture was lifted from Airtable, where we did the initial standardisation across clients. Building on existing goal definitions and boolean flags, it provided a consistent model that worked well for the core use case: send follow-ups until a goal is hit.

However, it's built on a pre-existing definition of "goal hit" and uses a flag-based approach to handling business logic and reporting that is hitting limitations in implementing features we want now and our longer term vision for the product.

The rest of this document assumes we will be moving all clients off Airtable, which enables us to undertake this architecture evolution.

### How It Works Today

We track lead lifecycle with boolean flags: `initial_message_sent`, `user_engaged`, `goal_presented`, `goal_hit`, `meeting_booked`, `human_intervention`, `not_interested_opted_out`. These control business logic, sync to CRM and power reporting.

Flags only flip one way: `False → True`. Once set, they stay set forever-partly because we need them for historical reporting.

**Goals** define success conditions. There are three goal types: URL clicked, third-party callback, and phrase match. Each follow-up policy configures which types should stop it. When a matching goal is hit, we set `goal_hit=True`.

**Stopping follow-ups** has two layers:
- **Hardcoded**: if `meeting_booked`, `human_intervention`, or `opted_out` is true, follow-ups stop
- **Configurable**: each follow-up policy selects which goal types stop it

### Problem 1: Flags Can't Move Backwards

Flags sync to client CRMs and power historical reporting, so they can't be reset. This means leads get stuck:

| Scenario | Expected | Actual |
|----------|----------|--------|
| No-show, lead re-engages | Rebook meeting | Stuck - `meeting_booked=True` forever |
| Lead goes cold, re-engages later | Restart follow-ups | Can't restart - flags are permanent |
| Opts out, then messages back | Resume conversation | Stuck - `opted_out=True` forever |

### Problem 2: Flags Are Overloaded

A flag like `meeting_booked` tries to do three things at once:

| Job | What it needs |
|-----|---------------|
| **Current state** | Mutable: after no-show `meeting_booked` is no longer `True` |
| **Historical record** | Immutable: "this lead booked a meeting once" for reporting |
| **Stopping logic** | Conditional: different events stop different behaviours |

These conflict. A single boolean can't serve all three purposes.

### Problem 3: What Counts as a Goal?

The 3 hardcoded goal types (link click, callback, phrase match) are often intermediate steps, not actual goals. `meeting_booked` isn't a goal type-it's a separate flag with its own stopping logic-yet for many clients, booking a meeting is the actual goal. As we extend the funnel, the real goal will shift for different clients (e.g. attending a meeting, closing a deal).

Both Airtable and our system have workarounds to stop follow-ups when particular events occur:
- **Airtable**: "agent end goal" flag to distinguish stopping vs non-stopping goals
- **Us**: explicit `goal_completion_types` configuration per follow-up policy

Both are workarounds which only exist because we're calling intermediate steps "goals". This configuration is confusing and will need further expansion as we add more skills. It's also somewhat inconsistent - why would clicking a link be an intermediate goal but not eliciting a reply from the lead?

If "goal" was defined as the agent's true endpoint, hitting a goal would naturally stop follow-ups (and other behaviours) without configuration.

Additionally, because goals are the only configurable stopping mechanism, we sometimes configure matching phrases as goals that aren't related to the agent's actual goal.

**This causes reporting confusion.** Many agents "hit their goal" (link clicked, phrase matched) without booking a meeting-which is often the real goal. Reports show high goal hit rates that don't reflect actual business outcomes.

### Problem 4: Hard to Reason About

The system has unexpected behaviours that are side effects of design rather than intentional choices:
- Stopping logic is scattered across multiple places with slightly different checks
- Unclear what the system does in edge cases without tracing through code
- New features require understanding the entire flag system and its interdependencies
- Each new flag doubles the state space (n flags = 2^n possible combinations), making the system exponentially harder to reason about

### Problem 5: No Event History

Flags record "did this ever happen" - not when, how often, or in what order.

Can't answer:
- How many meetings did this lead book?
- What was the sequence of events?
- Did opt-out happen before or after goal presentation?

### Problem 6: Can't Re-run Leads

Once flags like `goal_hit` or `meeting_booked` are set, they stay set forever. No way to:
- Re-engage churned or lost leads with a fresh sequence
- Sell again to existing customers (upsell, cross-sell)
- Handle leads who reach out again separately


### Why This Matters

The current architecture makes it problematic to implement all of the following:

- **Sparky**
  - Needs leads to move backwards (cold → engaged)
  - Flags can't reset

- **No-show rebooking**
  - Needs leads to move backwards (meeting_booked → qualification)
  - Flags can't reset

- **Re-run an existing lead**
  - Can't re-run churned leads or do upsells
  - Flags are permanent

- **Rich reporting**
  - Current reports on "goals hit" are confusing - a link click counts as goal hit, but booking a meeting is often the real goal
  - Reports show high goal hit rates that don't reflect actual business outcomes
  - Can't be fixed until we correctly define what a goal is
  - As we expand the system with more events, skills and states (no-show, meeting attended, deal closed), we need configurable reporting per agent
  - Flags only record "ever happened" - no event ordering, counts, or journey analytics

- **ABI orchestration and APE API**
  - Need clean entities, consistent definitions, and rich data
  - Will orchestrate and expose agent skills, which clients need to selectively activate
  - Currently: flags are overloaded, goals are confusing, skills are entangled with hardcoded flag logic
  - No modular boundary - can't activate a skill without understanding the whole system
  - ABI can only orchestrate what's well-defined; the API can only expose what's coherent; clients can only use what's modular
  - ABI reporting and analytics are only as good as the underlying data
  - The current foundation constrains everything built on top

- **Prototyping**
  - Hard to experiment with new behaviours
  - Each new skill touches flags, stopping logic, and goal configuration - no isolated boundary
  - Can't test one idea without understanding how it ripples through the entire system

Some of these could be implemented either partially or with limited functionality while also increasing tech debt and complexity.

Overall the current trajectory feels unsustainable and eventually it will become extremely difficult to extend the platform reliably or reason about the system. In particular, as we are about to start work on ABI and Ape AI to sit as innovate features on top of the underlying agentic system, now feels like the time to get the underlying architecture right.



---

## Proposed Architecture

A hierarchical state machine that separates:

- **State:** "where is this lead right now?" - mutable, controls behaviour
- **Events:** "what happened?" - immutable log, powers transitions and reporting
- **Transitions:** triggered by events, can be bidirectional where needed

<iframe src="https://stately.ai/registry/editor/embed/592dca8e-d0f1-4f3e-b4ed-f59f4ce6beb5?machineId=49b577fa-54be-4e96-9e5b-47995120cd19&mode=Design" width="100%" height="500px" frameborder="0"></iframe>

### States vs Events

A state represents a **mode of operation**. Three tests:

| Test | Question |
|------|----------|
| **Mutual exclusivity** | Can only be in one at a time? |
| **Changes behaviour** | Does entering change which events are valid or how the system responds? |
| **Finite** | Can you list all possible values? (not infinite like counts/timestamps) |

**Example:** `link.clicked` is NOT a state - a lead can click a link while `engaged`, it doesn't change their mode of operation, and the same events remain valid afterward. It's an **event** that gets logged.

### Parent States

States are grouped into parent states (hence hierarchical). This enables transitions that apply to all children.

Examples:
- `meeting.booked` from anywhere in `lead_qualification` → `meeting_booked`
- `goal.hit` or `conversation.stopped` from anywhere in `active` → terminal state

### Scope

The state machine is deliberately minimal:

- **Not all events handled** - only those causing transitions or side effects
- **Not all self-transitions shown** - omitted for clarity when no side effects
- **Minimal side effects** - only state and context mutations. Other concerns (CRM sync, notifications) handled by listeners.

One job: tracking where the lead is in their journey.

### Goals

Goals are configurable per agent. When the configured goal fires, `goal.hit` triggers and the lead moves to terminal `goal_hit` state.

### Stopping Scheduled Messages

The `follow_up.stopped` event stops follow-ups. Similar to goals, it fires when a configured condition is met - link clicked, third-party callback, phrase match, etc.

This replaces `goal_completion_types`. Instead of "which goal types stop follow-ups", we configure "when should follow-ups stop" - decoupled from goal tracking.

### Stopping the Conversation

The `conversation.stopped` event terminates the agent's work with the lead without hitting a goal. It fires when:
- Client manually takes over
- Configured conditions are met (e.g., lead goes cold and no Sparky enabled)
- External system triggers a stop

This moves the lead to terminal `conversation_stopped` state. Unlike `goal.hit`, this represents a handoff or abandonment, not success.

### Context & Actions

**Context** is minimal data alongside state - only values mutated by transitions, not general lead data:

```typescript
context: {
  followUpsStopped: boolean
}
```

Could expand to `checkInsStopped`, `noShowFollowUpsStopped` for independent control of other message types.

**Actions** mutate context on transitions:

| Action | Trigger | Effect |
|--------|---------|--------|
| `clearFollowUpStop` | Entry to `engaged` | `followUpsStopped = false` |
| `stopFollowUps` | `follow_up.stopped` event | `followUpsStopped = true` |

Entry to `engaged` resets `followUpsStopped` to `false`, so each time a lead re-engages (after going cold, no show etc.) they start fresh - previous stopping events don't carry over.

### Agent Independence

The AI agent is decoupled from the state machine:

- **Any framework** - LangGraph, LangChain, or any other
- **Read-only** - agent reads state, emits events; doesn't mutate state directly
- **State drives behaviour** - agent queries state and context to decide which skills are active, what actions are appropriate
- **Independent evolution** - agent logic can change without touching the state machine

The state machine defines *where the lead is*; the agent defines *how to behave*.

---

## What This Enables & Solves

### Operational Benefits

- **Visibility** - diagram shows entire lifecycle; living documentation
- **Auditability** - event log provides audit trail; debug via state + recent events
- **Testability** - deterministic; test each state independently
- **Reduced complexity** - invalid states structurally impossible; logic centralised

### Example lead flows now supported (pre-existing and new)

**Meeting booked as goal**

* Agent goal is to book a sales call. 
* Flow: Agent reaches out, lead engages, books meeting, goal hit.

<video src="media/meeting-booked-as-goal.mov" controls muted width="100%"></video>

**Sparky revival**

* Agent goal is to book a sales call
* Flow: Follow-ups exhaust, lead goes cold. Months later lead responds, books meeting.

**No-show rebooking**

* Agent goal is to attend a meeting
* Flow: Lead no-shows, re-engages, books again, attends meeting so goal is hit

**Opt-out then re-engagement**

* Agent goal is to attend a meeting
* Flow: Lead opts out, later messages back. Conversation resumes.

**Follow-up reset on re-engagement**

* Entry into `engaged` resets follow-up eligibility
* This flow demonstrates how `followUpsStopped` context works to allow follow-ups to resume when a lead re-engages.

Somewhere in our follow-ups sending code we would have a simple check (reading from the lead state and context) like:

```python
# Logic for determining if a lead can receive follow-ups
can_receive_follow_up = 
    state in ('engaged', 'outreach') # state
    and not follow_ups_stopped # context updated when we enter the engaged state
```

This enables the following flow: lead books meeting → stops follow-ups → no-shows → re-engages → follow-ups resume


**CRM override**

Client updates CRM field directly. State machine respects CRM as source of truth.

**Non-goal termination**

Client takes over when lead goes cold. Not a goal—just a handoff.

**Human intervention to deal**

Human takes over, closes deal via CRM. Events still logged.

**Re-entry after goal (upsell)**
```
[Conversation 1]
idle → ... → engaged → meeting.booked → meeting_booked → goal.hit

[Conversation 2 - same lead, fresh state]
idle → ... → engaged → deal.closed → deal_closed
```
Lead converastion terminates in first conversation (fails to convert or goal is hit). Later, lead engages again. Fresh state, but event history and chat history from conversation 1 available as context for second converastion.



### Goals

Goals become configurable per agent-any event can be the true endpoint, not just the 3 hardcoded types. This clears up reporting confusion and supports richer goal types in future:

| Type | Example | Description |
|------|---------|-------------|
| Simple | `meeting.booked` | Goal fires when event occurs |
| Conditional | `deal.closed` where value ≥ £10k | Event + property match |
| Composite OR | `meeting.booked` OR `deal.closed` | First matching event |
| Composite AND | `link.clicked` AND `meeting.booked` | Both events required |
| No goal | - | Agent works lead indefinitely |


### Reporting

With immutable event logs:

| Question | How |
|----------|-----|
| How many meetings did this lead book? | Count `meeting.booked` events |
| What's our no-show rate? | `meeting.missed` / `meeting.booked` |
| Time from first contact to meeting? | Time between first `agent.message_sent` and `meeting.booked` |
| Which leads re-engaged after going cold? | Leads with `cold` state followed by `lead.message_sent` |

### Can handle current skills we need properly (sparky, no show, check in)

#### Basic

**Meeting booked as goal**

* Agent goal is to book a sales call. 
* Flow: Agent reaches out, lead engages, books meeting, goal hit.

<video src="media/meeting-booked-as-goal.mov" controls muted width="100%"></video>

**Sparky revival**

* Agent goal is to book a sales call
* Flow: Follow-ups exhaust, lead goes cold. Months later lead responds, books meeting.

**No-show rebooking**

* Agent goal is to attend a meeting
* Flow: Lead no-shows, re-engages, books again, attends meeting so goal is hit

**Opt-out then re-engagement**

* Agent goal is to attend a meeting
* Flow: Lead opts out, later messages back. Conversation resumes.

**Follow-up reset on re-engagement**

* Entry into `engaged` resets follow-up eligibility
* This flow demonstrates how `followUpsStopped` context works to allow follow-ups to resume when a lead re-engages.

Somewhere in our follow-ups sending code we would have a simple check (reading from the lead state and context) like:

```python
# Logic for determining if a lead can receive follow-ups
can_receive_follow_up = 
    state in ('engaged', 'outreach') # state
    and not follow_ups_stopped # context updated when we enter the engaged state
```

This enables the following flow: lead books meeting → stops follow-ups → no-shows → re-engages → follow-ups resume


**CRM override**

Client updates CRM field directly. State machine respects CRM as source of truth.

**Non-goal termination**

Client takes over when lead goes cold. Not a goal-just a handoff.

**Human intervention to deal**

Human takes over, closes deal via CRM. Events still logged.

**Re-entry after goal (upsell)**
```
[Conversation 1]
idle → ... → engaged → meeting.booked → meeting_booked → goal.hit

[Conversation 2 - same lead, fresh state]
idle → ... → engaged → deal.closed → deal_closed
```
Lead converastion terminates in first conversation (fails to convert or goal is hit). Later, lead engages again. Fresh state, but event history and chat history from conversation 1 available as context for second converastion.


### Protyping and future skills

* Extremely configurable and pluggable 

* If we can expose 

## Renewals
```
deal_closed → [time passes] → renewal_due → agent.message_sent → renewal_outreach
→ lead.message_sent → renewal_engaged → deal.closed → deal_closed
```
Agent works same lead for renewal without new conversation.

## Payments
```
meeting_attended → payment.initiated → payment_pending
→ payment.completed → deal_closed
```
Agent handles payment collection directly.


### ABI and ape API
 
 




## Goal Configuration

