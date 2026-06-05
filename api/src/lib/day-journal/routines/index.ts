import { registerRoutine } from "../routine-registry";
import { SUMMARY_DAILY_ACCOMPLISHMENTS } from "./daily-accomplishments";
import { MARKET_SPY_QQQ_CLOSE } from "./market-spy-qqq-close";

registerRoutine(MARKET_SPY_QQQ_CLOSE);
registerRoutine(SUMMARY_DAILY_ACCOMPLISHMENTS);

export {
  DAY_JOURNAL_BASE_ROUTINE_PERMISSION,
  DAY_JOURNAL_ROUTINE_PERMISSIONS,
  DAY_JOURNAL_SCOPED_AUTHORITY_PERMISSIONS,
  defaultTargetPathForRoutine,
  getRoutine,
  listRoutines,
  registerRoutine,
  routineNeedsScopedAuthority,
  type DayJournalRoutineContext,
  type DayJournalRoutineDefinition,
  type DayJournalRoutinePermission,
} from "../routine-registry";
