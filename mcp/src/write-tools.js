/* The write tools. Each one is { name, description, schema, apply }: `apply(S, params)` changes a
   copy of the profile's document and says what it did (writes.js), and index.js runs it through
   remote.js, which reads the document from the openGym api, applies the change and writes it back
   over the revision it read. These tools exist only in remote mode: a document edited on the disk
   behind the api would race every phone's sync. */
import { z } from 'zod'
import {
  createRoutine, updateRoutine, setWeekPlan, addBodyweight, addMeasurements, logWorkout,
  DAY_KEYS, BODYPARTS, MUSCLES, MEASUREMENT_KEYS
} from './writes.js'

// Same calendar check as the read tools (tools.js isoDate): 2026-02-30 is refused, not rolled over.
const localIso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
const isoDate = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').refine(
  v => { const d = new Date(v + 'T12:00:00'); return !Number.isNaN(d.getTime()) && localIso(d) === v },
  { message: 'not a date the calendar has (YYYY-MM-DD)' }
)
const day = z.enum(DAY_KEYS)

const exercise = z.object({
  exercise_id: z.string().min(1).optional().describe('Library or custom exercise id, from find_exercise.'),
  exercise_name: z.string().min(1).optional().describe('Exact library name, e.g. "barbell bench press". Unknown names fail with the closest matches.'),
  custom: z.object({
    name: z.string().min(1).max(80),
    body_part: z.enum(BODYPARTS),
    equipment: z.string().max(40).optional(),
    description: z.string().max(1000).optional(),
    primary_muscles: z.array(z.enum(MUSCLES)).max(6).optional(),
    secondary_muscles: z.array(z.enum(MUSCLES)).max(10).optional()
  }).optional().describe('Create a custom exercise for something the library does not have (find_exercise first). An existing custom with the same name and body part is reused.'),
  sets: z.number().int().min(1).max(20),
  reps: z.number().int().min(1).max(100).optional(),
  reps_min: z.number().int().min(1).max(100).optional().describe('Bottom of a rep range, with reps_max: the exercise climbs the range before the weight goes up (double progression).'),
  reps_max: z.number().int().min(1).max(100).optional(),
  progression: z.enum(['off', 'linear', 'greyskull', 'double', 'triple', 'time']).optional().describe("How the app moves this exercise on after a session. Default: linear for reps, double for a rep range, off for timed and cardio."),
  seconds: z.number().int().min(1).max(3600).optional().describe('Timed exercise (plank, circuit station): seconds per set instead of reps.'),
  minutes: z.number().min(1).max(600).optional().describe('Cardio: minutes per set instead of reps.'),
  speed: z.number().min(0).max(100).optional().describe('Cardio speed, with minutes.'),
  weight: z.number().min(0).max(1000).optional().describe("Working weight, in the profile's unit unless weight_unit says otherwise."),
  weight_unit: z.enum(['kg', 'lb']).optional(),
  rest_sec: z.number().int().min(0).max(900).optional().describe('Rest after each set. Absent: the profile default.'),
  superset: z.string().min(1).max(40).optional().describe('Exercises listed one after another with the same label form a superset or circuit.'),
  superset_rest_sec: z.number().int().min(0).max(900).optional().describe('Rest after each round of the superset.')
})

export const createRoutineTool = {
  name: 'create_routine',
  description: 'Create a new routine in the openGym app from a description, optionally scheduling it on weekdays (added beside whatever those days already hold). Look exercises up with find_exercise first; use `custom` only for movements the library lacks. The app shows the routine on its next sync, exactly as if a plan file had been imported.',
  schema: {
    name: z.string().min(1).max(60),
    emoji: z.string().max(8).optional(),
    exercises: z.array(exercise).min(1).max(40),
    days: z.array(day).max(7).optional()
  },
  apply: (S, p) => createRoutine(S, p)
}

export const updateRoutineTool = {
  name: 'update_routine',
  description: "Rename a routine and/or replace its whole exercise list (same exercise format as create_routine). The list replaces the old one entirely, so read it with get_routine first and send back every exercise that should stay. Workouts already logged are not touched.",
  schema: {
    routine_id: z.string().min(1),
    name: z.string().min(1).max(60).optional(),
    emoji: z.string().max(8).optional(),
    exercises: z.array(exercise).min(1).max(40).optional()
  },
  apply: (S, p) => updateRoutine(S, p)
}

export const setWeekPlanTool = {
  name: 'set_week_plan',
  description: 'Set which routines the listed weekdays hold (routine ids from list_routines); an empty list makes that day a rest day. Days not listed are left as they are.',
  schema: {
    days: z.record(day, z.array(z.string().min(1)).max(4)).refine(o => Object.keys(o).length > 0, { message: 'give at least one day' })
  },
  apply: (S, p) => setWeekPlan(S, p)
}

export const addBodyweightTool = {
  name: 'add_bodyweight',
  description: "Log a weigh-in (default today). A second weigh-in on the same day replaces the first, as in the app. Stored in the profile's unit; pass unit to convert.",
  schema: {
    weight: z.number().min(20).max(700),
    unit: z.enum(['kg', 'lb']).optional(),
    date: isoDate().optional()
  },
  apply: (S, p) => addBodyweight(S, p)
}

export const addMeasurementsTool = {
  name: 'add_measurements',
  description: `Log body measurements for a day (default today), merged into that day's entry: fields given replace, others stay. Circumferences in cm (or unit "in"), bodyFat in percent. Keys: ${MEASUREMENT_KEYS.join(', ')}.`,
  schema: {
    values: z.record(z.enum(MEASUREMENT_KEYS), z.number().positive().max(400)),
    unit: z.enum(['cm', 'in']).optional(),
    date: isoDate().optional()
  },
  apply: (S, p) => addMeasurements(S, p)
}

const loggedSet = z.object({
  reps: z.number().int().min(0).max(1000).optional(),
  weight: z.number().min(0).max(1000).optional().describe("Load in the profile's unit (or the exercise's weight_unit); on a bodyweight exercise, the added weight."),
  seconds: z.number().int().min(1).max(36000).optional().describe('A timed set (plank, circuit station).'),
  minutes: z.number().min(0.1).max(1440).optional().describe('A cardio set.'),
  speed: z.number().min(0).max(100).optional(),
  warmup: z.boolean().optional().describe('A warm-up set: kept out of volume, PRs and progression.'),
  rir: z.number().min(0).max(10).optional().describe('Reps in reserve.'),
  rpe: z.number().min(1).max(10).optional().describe('Rate of perceived exertion (instead of rir).'),
  failure: z.boolean().optional().describe('Taken to failure.')
})

export const logWorkoutTool = {
  name: 'log_workout',
  description: "Log a workout that is done (today or an earlier day), the way the app's \"Log a past workout\" saves one: each set ticked, PRs judged against the history before it, and the next session's prescription moving on from it. Give routine_id when it followed a routine (its exercises are matched by exercise; the ones not logged count as skipped). Check list_workouts first so a session is not logged twice; replace_workout_id re-logs an existing one.",
  schema: {
    date: isoDate().optional().describe('Day it was done; default today. Not in the future.'),
    start_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM').optional().describe('Default 18:00.'),
    duration_min: z.number().int().min(1).max(1440).optional().describe('Default 60.'),
    routine_id: z.string().min(1).optional(),
    name: z.string().min(1).max(60).optional().describe("Default: the routine's name, or Freestyle."),
    note: z.string().max(1000).optional(),
    replace_workout_id: z.string().min(1).optional(),
    exercises: z.array(z.object({
      exercise_id: z.string().min(1).optional(),
      exercise_name: z.string().min(1).optional(),
      custom: exercise.shape.custom,
      weight_unit: z.enum(['kg', 'lb']).optional(),
      note: z.string().max(280).optional(),
      sets: z.array(loggedSet).min(1).max(50)
    })).min(1).max(40)
  },
  apply: (S, p) => logWorkout(S, p)
}

export const WRITE_TOOLS = [createRoutineTool, updateRoutineTool, setWeekPlanTool, addBodyweightTool, addMeasurementsTool, logWorkoutTool]
