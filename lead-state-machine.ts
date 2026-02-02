import { setup, assign } from "xstate";

export const machine = setup({
  types: {
    context: {} as { followUpsStopped: boolean },
    events: {} as
      | { type: "agent.message_sent" }
      | { type: "voice_call.initiated" }
      | { type: "lead.message_sent" }
      | { type: "follow_up.sequence_completed" }
      | { type: "follow_up.stopped" }
      | { type: "lead.opted_out" }
      | { type: "meeting.booked" }
      | { type: "deal.closed" }
      | { type: "human.intervened" }
      | { type: "meeting.attended" }
      | { type: "meeting.missed" }
      | { type: "goal.hit" }
      | { type: "conversation.stopped" }
      | { type: "conversation.paused" }
      | { type: "conversation.resumed" },
  },
  actions: {
    clearFollowUpStop: (() => {
      return assign({
        followUpsStopped: false,
      });
    })(),
    stopFollowUps: (() => {
      return assign({
        followUpsStopped: true,
      });
    })(),
  },
}).createMachine({
  context: {
    followUpsStopped: false,
  },
  id: "lead",
  initial: "active",
  states: {
    active: {
      initial: "lead_qualification",
      on: {
        "goal.hit": {
          target: "goal_hit",
        },
        "conversation.stopped": {
          target: "conversation_stopped",
        },
        "conversation.paused": {
          target: "conversation_paused",
        },
      },
      description: "Lead is actively being worked",
      states: {
        lead_qualification: {
          initial: "idle",
          on: {
            "meeting.booked": {
              target: "#lead.active.conversion.meeting_booked",
            },
            "deal.closed": {
              target: "deal_closed",
            },
            "human.intervened": {
              target: "human_intervention",
            },
          },
          description: "Qualifying the lead through outreach and engagement",
          states: {
            idle: {
              on: {
                "agent.message_sent": {
                  target: "outreach",
                },
                "voice_call.initiated": {
                  target: "outreach",
                },
                "lead.message_sent": {
                  target: "engaged",
                },
              },
              description: "Lead imported, no contact made yet",
            },
            outreach: {
              on: {
                "lead.message_sent": {
                  target: "engaged",
                },
                "follow_up.sequence_completed": {
                  target: "cold",
                },
                "follow_up.stopped": {
                  target: "outreach",
                  actions: {
                    type: "stopFollowUps",
                  },
                },
              },
              description: "Agent has reached out, awaiting lead response",
            },
            engaged: {
              on: {
                "follow_up.sequence_completed": {
                  target: "cold",
                },
                "follow_up.stopped": {
                  target: "engaged",
                  actions: {
                    type: "stopFollowUps",
                    params: {
                      followUpsStopped: true,
                    },
                  },
                },
                "lead.opted_out": {
                  target: "opted_out",
                },
              },
              entry: {
                type: "clearFollowUpStop",
                params: {
                  followUpsStopped: false,
                },
              },
              description: "Active two-way conversation with lead",
            },
            cold: {
              on: {
                "lead.message_sent": {
                  target: "engaged",
                },
              },
              tags: "sparky",
              description: "Lead unresponsive, in long-term nurturing",
            },
            opted_out: {
              on: {
                "lead.message_sent": {
                  target: "engaged",
                },
              },
              description: "Lead has opted out of communications",
            },
          },
        },
        deal_closed: {
          type: "final",
          description: "Deal closed successfully",
        },
        human_intervention: {
          on: {
            "meeting.booked": {
              target: "#lead.active.conversion.meeting_booked",
            },
            "deal.closed": {
              target: "deal_closed",
            },
          },
          description: "Human has taken over, agent paused",
        },
        hist: {
          type: "history",
          history: "shallow",
          description: "Remembers the last active state.",
        },
        conversion: {
          initial: "meeting_booked",
          on: {
            "deal.closed": {
              target: "deal_closed",
            },
            "human.intervened": {
              target: "human_intervention",
            },
          },
          description: "Lead is in the sales conversion process",
          states: {
            meeting_booked: {
              on: {
                "meeting.attended": {
                  target: "meeting_attended",
                },
                "meeting.missed": {
                  target: "meeting_missed",
                },
              },
              tags: "check_in",
              description: "Meeting scheduled, awaiting attendance",
            },
            meeting_attended: {
              description: "Lead attended meeting, awaiting deal outcome",
            },
            meeting_missed: {
              on: {
                "lead.message_sent": {
                  target: "#lead.active.lead_qualification.engaged",
                },
                "meeting.booked": {
                  target: "meeting_booked",
                },
              },
              tags: "no_show",
              description: "Lead missed meeting, attempting to rebook",
            },
          },
        },
      },
    },
    goal_hit: {
      type: "final",
      description: "Lead achieved configured goal",
    },
    conversation_stopped: {
      type: "final",
      description: "Conversation permanently stopped",
    },
    conversation_paused: {
      on: {
        "conversation.resumed": {
          target: "#lead.active.hist",
        },
      },
      description: "Conversation temporarily paused",
    },
  },
});