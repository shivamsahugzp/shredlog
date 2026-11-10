#!/usr/bin/env python3
"""Rebuild data/exercises.json from free-exercise-db (Unlicense / public domain).

Usage:  python3 -I scripts/build-exercises.py <path-to-free-exercise-db-dist-exercises.json>
        (EXERCISES_OUT=/some/path writes a preview there instead of overwriting data/exercises.json)

What it does (idempotent: it always starts from the first BASE_COUNT entries of the
current data/exercises.json, so running it twice gives the same file):
  1. Keeps the original 198 exercises untouched (id/name/cat/muscles/equipment/type/
     met/cues/mistakes/kw never change) and only ADDS optional fields
     steps / img / level / mechanic / force where a confident source match exists.
  2. Adds curated new exercises from the source (machines, cables, dumbbell/barbell
     variations, a limited set of stretches) plus hand-written entries for the machine
     checklist items the source lacks (see MANUAL below).
  3. Writes the merged file and prints a summary + validation.

The source file is treated as untrusted data: it is only parsed as JSON, text fields
are sanitised, and nothing in it is ever executed.
"""
import json, os, re, sys, urllib.parse
from collections import Counter, OrderedDict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data', 'exercises.json')
IMG_BASE = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/'
BASE_COUNT = 198  # the user's original catalogue; workout history references these ids

CATS = ['Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps', 'Forearms', 'Quads', 'Hamstrings',
        'Glutes', 'Calves', 'Core', 'Full Body', 'Cardio', 'Mobility']
MUSCLES = {'chest', 'front delts', 'side delts', 'rear delts', 'biceps', 'triceps', 'forearms',
           'abs', 'obliques', 'hip flexors', 'lats', 'upper back', 'traps', 'lower back', 'glutes',
           'quads', 'hamstrings', 'adductors', 'calves'}
EQUIP = {'barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'smith', 'band', 'plate',
         'kettlebell', 'other', 'none'}
TYPES = {'strength', 'bodyweight', 'timed', 'cardio'}
LEVELS = {'beginner', 'intermediate', 'expert'}
MECHS = {'compound', 'isolation'}
FORCES = {'push', 'pull', 'static'}

# ---------------------------------------------------------------------------------------
# 1. Existing exercise id -> source record name (explicit, reviewed matches only).
#    Anything not listed here (and not auto-matched on an identical normalised name)
#    simply gets no source steps/images.
# ---------------------------------------------------------------------------------------
ALIASES = {
    # chest
    'barbell_bench_press': 'Barbell Bench Press - Medium Grip',
    'incline_barbell_bench_press': 'Barbell Incline Bench Press - Medium Grip',
    'decline_barbell_bench_press': 'Decline Barbell Bench Press',
    'dumbbell_bench_press': 'Dumbbell Bench Press',
    'incline_dumbbell_press': 'Incline Dumbbell Press',
    'dumbbell_fly': 'Dumbbell Flyes',
    'incline_dumbbell_fly': 'Incline Dumbbell Flyes',
    'machine_chest_press': 'Machine Bench Press',
    'pec_deck': 'Butterfly',
    'cable_fly_high': 'Cable Crossover',
    'cable_fly_low': 'Low Cable Crossover',
    'push_up': 'Pushups',
    'decline_push_up': 'Decline Push-Up',
    'incline_push_up': 'Incline Push-Up',
    'chest_dips': 'Dips - Chest Version',
    'dumbbell_pullover': 'Bent-Arm Dumbbell Pullover',
    'smith_machine_bench_press': 'Smith Machine Bench Press',
    # back
    'conventional_deadlift': 'Barbell Deadlift',
    'rack_pull': 'Rack Pulls',
    'trap_bar_deadlift': 'Trap Bar Deadlift',
    'barbell_bent_over_row': 'Bent Over Barbell Row',
    'dumbbell_row': 'One-Arm Dumbbell Row',
    'chest_supported_dumbbell_row': 'Dumbbell Incline Row',
    't_bar_row': 'T-Bar Row with Handle',
    'seated_cable_row': 'Seated Cable Rows',
    'single_arm_cable_row': 'Seated One-arm Cable Pulley Rows',
    'lat_pulldown_wide': 'Wide-Grip Lat Pulldown',
    'lat_pulldown_close': 'Close-Grip Front Lat Pulldown',
    'reverse_grip_lat_pulldown': 'Underhand Cable Pulldowns',
    'single_arm_lat_pulldown': 'One Arm Lat Pulldown',
    'straight_arm_pulldown': 'Straight-Arm Pulldown',
    'pull_up': 'Pullups',
    'chin_up': 'Chin-Up',
    'neutral_grip_pull_up': 'V-Bar Pullup',
    'inverted_row': 'Inverted Row',
    'back_extension': 'Hyperextensions (Back Extensions)',
    'superman': 'Superman',
    'band_pull_apart': 'Band Pull Apart',
    'barbell_shrug': 'Barbell Shrug',
    'dumbbell_shrug': 'Dumbbell Shrug',
    # shoulders
    'overhead_press': 'Standing Military Press',
    'seated_dumbbell_shoulder_press': 'Seated Dumbbell Press',
    'arnold_press': 'Arnold Dumbbell Press',
    'machine_shoulder_press': 'Machine Shoulder (Military) Press',
    'smith_shoulder_press': 'Smith Machine Overhead Shoulder Press',
    'push_press': 'Push Press',
    'dumbbell_lateral_raise': 'Side Lateral Raise',
    'cable_lateral_raise': 'Standing Low-Pulley Deltoid Raise',
    'dumbbell_front_raise': 'Front Dumbbell Raise',
    'plate_front_raise': 'Front Plate Raise',
    'dumbbell_rear_delt_fly': 'Reverse Flyes',
    'reverse_pec_deck': 'Reverse Machine Flyes',
    'cable_rear_delt_fly': 'Cable Rear Delt Fly',
    'cable_face_pull': 'Face Pull',
    'upright_row': 'Upright Barbell Row',
    # biceps
    'barbell_curl': 'Barbell Curl',
    'ez_bar_curl': 'EZ-Bar Curl',
    'dumbbell_curl': 'Dumbbell Bicep Curl',
    'hammer_curl': 'Hammer Curls',
    'incline_dumbbell_curl': 'Incline Dumbbell Curl',
    'concentration_curl': 'Concentration Curls',
    'cable_curl': 'Standing Biceps Cable Curl',
    'preacher_curl': 'Preacher Curl',
    'spider_curl': 'Spider Curl',
    # triceps
    'close_grip_bench_press': 'Close-Grip Barbell Bench Press',
    'skull_crusher': 'EZ-Bar Skullcrusher',
    'tricep_pushdown_rope': 'Triceps Pushdown - Rope Attachment',
    'tricep_pushdown_bar': 'Triceps Pushdown',
    'overhead_cable_tricep_extension': 'Triceps Overhead Extension with Rope',
    'dumbbell_overhead_tricep_extension': 'Standing Dumbbell Triceps Extension',
    'dumbbell_tricep_kickback': 'Tricep Dumbbell Kickback',
    'tricep_dips': 'Dips - Triceps Version',
    'bench_dips': 'Bench Dips',
    'diamond_push_up': 'Push-Ups - Close Triceps Position',
    # forearms
    'wrist_curl': 'Palms-Up Dumbbell Wrist Curl Over A Bench',
    'reverse_wrist_curl': 'Palms-Down Dumbbell Wrist Curl Over A Bench',
    'reverse_curl': 'Reverse Barbell Curl',
    'farmers_walk': "Farmer's Walk",
    # quads
    'barbell_back_squat': 'Barbell Full Squat',
    'front_squat': 'Front Barbell Squat',
    'goblet_squat': 'Goblet Squat',
    'reverse_lunge': 'Dumbbell Rear Lunge',
    'step_up': 'Dumbbell Step Ups',
    'leg_press': 'Leg Press',
    'hack_squat': 'Hack Squat',
    'leg_extension': 'Leg Extensions',
    'smith_machine_squat': 'Smith Machine Squat',
    'bodyweight_squat': 'Bodyweight Squat',
    'jump_squat': 'Freehand Jump Squat',
    # hamstrings
    'romanian_deadlift': 'Romanian Deadlift',
    'dumbbell_rdl': 'Stiff-Legged Dumbbell Deadlift',
    'stiff_leg_deadlift': 'Stiff-Legged Barbell Deadlift',
    'good_morning': 'Good Morning',
    'seated_leg_curl': 'Seated Leg Curl',
    'lying_leg_curl': 'Lying Leg Curls',
    'nordic_curl': 'Natural Glute Ham Raise',
    # glutes
    'hip_thrust': 'Barbell Hip Thrust',
    'glute_bridge': 'Butt Lift (Bridge)',
    'single_leg_glute_bridge': 'Single Leg Glute Bridge',
    'cable_pull_through': 'Pull Through',
    'hip_abductor_machine': 'Thigh Abductor',
    'hip_adductor_machine': 'Thigh Adductor',
    'cable_glute_kickback': 'One-Legged Cable Kickback',
    'donkey_kick': 'Glute Kickback',
    'banded_lateral_walk': 'Monster Walk',
    'sumo_deadlift': 'Sumo Deadlift',
    'dumbbell_sumo_squat': 'Plie Dumbbell Squat',
    # calves
    'standing_calf_raise': 'Standing Calf Raises',
    'seated_calf_raise': 'Seated Calf Raise',
    'leg_press_calf_raise': 'Calf Press On The Leg Press Machine',
    # core
    'plank': 'Plank',
    'side_plank': 'Side Bridge',
    'hanging_leg_raise': 'Hanging Leg Raise',
    'crunch': 'Crunches',
    'bicycle_crunch': 'Air Bike',
    'russian_twist': 'Russian Twist',
    'mountain_climbers': 'Mountain Climbers',
    'lying_leg_raise': 'Flat Bench Lying Leg Raise',
    'dead_bug': 'Dead Bug',
    'ab_wheel_rollout': 'Ab Roller',
    'cable_crunch': 'Cable Crunch',
    'ab_crunch_machine': 'Ab Crunch Machine',
    'cable_woodchop': 'Standing Cable Wood Chop',
    'pallof_press': 'Pallof Press',
    'reverse_crunch': 'Reverse Crunch',
    'v_up': 'Jackknife Sit-Up',
    'flutter_kicks': 'Flutter Kicks',
    'heel_touches': 'Alternate Heel Touchers',
    # full body
    'kettlebell_goblet_squat': 'Goblet Squat',
    'kettlebell_clean': 'One-Arm Kettlebell Clean',
    'kettlebell_snatch': 'One-Arm Kettlebell Snatch',
    'turkish_get_up': 'Kettlebell Turkish Get-Up (Squat style)',
    'box_jump': 'Front Box Jump',
    'battle_ropes': 'Battling Ropes',
    'sled_push': 'Sled Push',
    'medicine_ball_slam': 'Overhead Slam',
    # cardio
    'treadmill_walk': 'Walking, Treadmill',
    'cycling_stationary': 'Bicycling, Stationary',
    'cycling_outdoor': 'Bicycling',
    'elliptical': 'Elliptical Trainer',
    'stair_climber': 'Stairmaster',
    'rowing_machine': 'Rowing, Stationary',
    'skipping_rope': 'Rope Jumping',
    # mobility
    'childs_pose': "Child's Pose",
    'worlds_greatest_stretch': "World's Greatest Stretch",
    'hamstring_stretch': 'Seated Floor Hamstring Stretch',
    'hip_flexor_stretch': 'Kneeling Hip Flexor',
    'cat_cow': 'Cat Stretch',
}

# ---------------------------------------------------------------------------------------
# 2. Curated list of source records to add as NEW exercises.
#    Line format:  Source Name [=> New Name] [; key=value ...]
#    keys: cat, eq, type, met, mus (comma separated), force.   '#' lines are comments.
#    Source records not listed here (and not aliased above) are deliberately skipped:
#    strongman / foam-rolling / plyometric drills / chain-and-band powerlifting variants /
#    near-duplicates / niche or unsafe moves.
# ---------------------------------------------------------------------------------------
NEW_TEXT = """
# ---- Chest
Cable Chest Press => Cable Chest Press (Seated)
Standing Cable Chest Press => Cable Chest Press (Standing)
Incline Cable Chest Press
Incline Cable Flye => Incline Cable Fly
Flat Bench Cable Flyes => Flat Bench Cable Fly
Single-Arm Cable Crossover
Leverage Chest Press => Plate-Loaded Chest Press (Hammer Strength)
Leverage Incline Chest Press => Incline Machine Chest Press
Leverage Decline Chest Press => Decline Machine Chest Press
Decline Dumbbell Bench Press
Decline Dumbbell Flyes => Decline Dumbbell Fly
Dumbbell Bench Press with Neutral Grip => Neutral-Grip Dumbbell Bench Press
Hammer Grip Incline DB Bench Press => Neutral-Grip Incline Dumbbell Press
One Arm Dumbbell Bench Press => One-Arm Dumbbell Bench Press
One-Arm Flat Bench Dumbbell Flye => One-Arm Dumbbell Fly
Dumbbell Floor Press
Floor Press => Barbell Floor Press
Wide-Grip Barbell Bench Press
Smith Machine Incline Bench Press
Decline Smith Press => Smith Machine Decline Bench Press
Push-Up Wide => Wide Push-Up
Single-Arm Push-Up
Plyo Push-up => Plyometric Push-Up ; cat=Chest ; type=bodyweight ; met=6
Svend Press
Straight-Arm Dumbbell Pullover ; mus=chest,lats,triceps
Cross Over - With Bands => Band Chest Fly ; eq=band ; type=bodyweight ; mus=chest,front delts
Suspended Push-Up => TRX Push-Up ; type=bodyweight
Around The Worlds => Dumbbell Around the World
Incline Push-Up Close-Grip => Close-Grip Incline Push-Up ; cat=Chest
Incline Push-Up Wide => Wide Incline Push-Up
Medicine Ball Chest Pass ; cat=Chest ; type=strength ; met=5

# ---- Back
Barbell Shrug Behind The Back
Cable Shrugs => Cable Shrug
Leverage Shrug => Machine Shrug
Smith Machine Behind the Back Shrug => Smith Machine Shrug (Behind the Back)
Lying T-Bar Row => Chest-Supported T-Bar Row
Leverage Iso Row => Plate-Loaded Iso Row (Hammer Strength)
Leverage High Row => High Row Machine (Plate-Loaded)
Bent Over Two-Dumbbell Row => Bent-Over Dumbbell Row
Bent Over Two-Arm Long Bar Row => Long Bar Row (Two-Arm)
Reverse Grip Bent-Over Rows => Reverse-Grip Barbell Row
Smith Machine Bent Over Row => Smith Machine Bent-Over Row
Smith Machine Upright Row ; cat=Shoulders ; mus=side delts,traps,biceps
Upright Cable Row => Cable Upright Row ; cat=Shoulders ; mus=side delts,traps,biceps
Standing Dumbbell Upright Row => Dumbbell Upright Row ; cat=Shoulders ; mus=side delts,traps,biceps
Kneeling High Pulley Row => Kneeling High-Pulley Row
Kneeling Single-Arm High Pulley Row => Kneeling Single-Arm High-Pulley Row
V-Bar Pulldown => Lat Pulldown (V-Bar)
Rope Straight-Arm Pulldown => Straight-Arm Pulldown (Rope)
Cable Incline Pushdown => Incline Cable Pushdown (Lat)
Band Assisted Pull-Up => Band-Assisted Pull-Up ; eq=band ; type=bodyweight ; mus=lats,upper back,biceps
Weighted Pull Ups => Weighted Pull-Up ; type=strength ; eq=bodyweight
Scapular Pull-Up ; eq=bodyweight ; type=bodyweight
Muscle Up ; eq=bodyweight ; type=bodyweight ; met=6
Mixed Grip Chin => Mixed-Grip Chin-Up ; eq=bodyweight ; type=bodyweight
Suspended Row => TRX Row (Suspended Row) ; type=bodyweight
Reverse Hyperextension ; cat=Glutes ; mus=glutes,lower back,hamstrings ; eq=machine
Deficit Deadlift
Lying Face Up Plate Neck Resistance => Plate Neck Flexion ; cat=Back ; mus=traps
Lying Face Down Plate Neck Resistance => Plate Neck Extension ; cat=Back ; mus=traps
Alternating Kettlebell Row => Kettlebell Alternating Row

# ---- Shoulders
Cable Shoulder Press
Dumbbell One-Arm Shoulder Press => One-Arm Dumbbell Shoulder Press
Standing Dumbbell Press => Standing Dumbbell Shoulder Press
Standing Palms-In Dumbbell Press => Neutral-Grip Dumbbell Shoulder Press
Leverage Shoulder Press => Plate-Loaded Shoulder Press (Hammer Strength)
Seated Barbell Military Press => Seated Barbell Shoulder Press
Shoulder Press - With Bands => Band Shoulder Press ; eq=band ; type=bodyweight
Lateral Raise - With Bands => Band Lateral Raise ; eq=band ; type=bodyweight
Lying One-Arm Lateral Raise
Seated Side Lateral Raise => Seated Dumbbell Lateral Raise
One-Arm Incline Lateral Raise ; mus=side delts
Front Cable Raise => Cable Front Raise
Cuban Press
Dumbbell Scaption
Handstand Push-Ups => Handstand Push-Up
External Rotation => Dumbbell External Rotation ; mus=rear delts,upper back
External Rotation with Cable => Cable External Rotation ; mus=rear delts,upper back
External Rotation with Band => Band External Rotation ; eq=band ; type=bodyweight ; mus=rear delts,upper back
Cable Internal Rotation ; mus=front delts,chest
Bent Over Low-Pulley Side Lateral => Low-Pulley Rear Delt Raise (Cable) ; mus=rear delts,upper back
Cable Rope Rear-Delt Rows => Cable Rope Rear Delt Row
Seated Bent-Over Rear Delt Raise => Seated Rear Delt Raise
Bent Over Dumbbell Rear Delt Raise With Head On Bench => Head-Supported Rear Delt Raise
Barbell Rear Delt Row
Back Flyes - With Bands => Band Reverse Fly ; eq=band ; type=bodyweight
Lying Rear Delt Raise
Clean and Press => Barbell Clean and Press ; cat=Full Body ; met=6
Cable Seated Lateral Raise => Seated Cable Rear Delt Raise ; mus=rear delts,upper back,traps
Dumbbell Incline Shoulder Raise => Incline Dumbbell Shoulder Raise
Front Incline Dumbbell Raise => Incline Dumbbell Front Raise
Side Laterals to Front Raise => Side Lateral to Front Raise ; mus=side delts,front delts
Standing Alternating Dumbbell Press => Alternating Dumbbell Shoulder Press
Standing Front Barbell Raise Over Head => Barbell Front Raise (Overhead)

# ---- Biceps
Alternate Hammer Curl => Alternating Hammer Curl
Incline Hammer Curls => Incline Hammer Curl
Cross Body Hammer Curl => Cross-Body Hammer Curl
Seated Dumbbell Curl
Dumbbell Alternate Bicep Curl => Alternating Dumbbell Curl
Zottman Curl
Preacher Hammer Dumbbell Curl => Hammer Preacher Curl
One Arm Dumbbell Preacher Curl => One-Arm Dumbbell Preacher Curl
Two-Arm Dumbbell Preacher Curl => Dumbbell Preacher Curl
Cable Preacher Curl
Cable Hammer Curls - Rope Attachment => Cable Hammer Curl (Rope)
Lying Cable Curl
High Cable Curls => High Cable Curl
Overhead Cable Curl
Reverse Cable Curl
Standing One-Arm Cable Curl => One-Arm Cable Curl
Machine Bicep Curl => Machine Biceps Curl
Machine Preacher Curls => Machine Preacher Curl
Close-Grip EZ Bar Curl => Close-Grip EZ-Bar Curl
Wide-Grip Standing Barbell Curl => Wide-Grip Barbell Curl
Drag Curl
Standing Dumbbell Reverse Curl => Dumbbell Reverse Curl
Barbell Curls Lying Against An Incline => Incline Bench Barbell Curl
Reverse Barbell Preacher Curls => Reverse EZ-Bar Preacher Curl
Dumbbell Prone Incline Curl => Prone Incline Dumbbell Curl
Incline Inner Biceps Curl => Incline Inner-Biceps Curl
Standing Concentration Curl
Lying High Bench Barbell Curl => High-Bench Barbell Curl
Lying Supine Dumbbell Curl
Seated Dumbbell Inner Biceps Curl => Seated Inner-Biceps Curl
Reverse Plate Curls => Reverse Plate Curl ; eq=plate

# ---- Triceps
Triceps Pushdown - V-Bar Attachment => Tricep Pushdown (V-Bar)
Reverse Grip Triceps Pushdown => Tricep Pushdown (Reverse Grip)
Dip Machine => Seated Dip Machine
Machine Triceps Extension
Cable Incline Triceps Extension => Incline Cable Triceps Extension
Cable Lying Triceps Extension => Lying Cable Triceps Extension
Cable One Arm Tricep Extension => One-Arm Cable Triceps Extension
Kneeling Cable Triceps Extension
Standing Low-Pulley One-Arm Triceps Extension => One-Arm Low-Pulley Triceps Extension
Lying Dumbbell Tricep Extension => Lying Dumbbell Triceps Extension
Dumbbell One-Arm Triceps Extension => One-Arm Dumbbell Triceps Extension
Standing Overhead Barbell Triceps Extension => Standing Barbell Triceps Extension
Incline Barbell Triceps Extension
Seated Triceps Press => Seated Dumbbell Triceps Extension
Decline Dumbbell Triceps Extension
Decline EZ Bar Triceps Extension => Decline EZ-Bar Triceps Extension
Lying Triceps Press => EZ-Bar Lying Triceps Press
Lying Close-Grip Barbell Triceps Extension Behind The Head => Lying Barbell Triceps Extension (Behind Head)
Reverse Triceps Bench Press => Reverse-Grip Triceps Bench Press ; mus=triceps,chest,front delts
JM Press
Tate Press
Body Tricep Press => Bodyweight Triceps Extension ; type=bodyweight
Close-Grip Dumbbell Press
Close-Grip EZ-Bar Press
Smith Machine Close-Grip Bench Press
Weighted Bench Dip ; eq=bodyweight ; type=strength
Ring Dips => Ring Dip ; type=bodyweight

# ---- Forearms
Palms-Up Barbell Wrist Curl Over A Bench => Barbell Wrist Curl
Palms-Down Wrist Curl Over A Bench => Barbell Reverse Wrist Curl
Cable Wrist Curl
Seated Two-Arm Palms-Up Low-Pulley Wrist Curl => Low-Pulley Wrist Curl
Plate Pinch ; type=timed
Wrist Roller
Dumbbell Lying Pronation => Dumbbell Forearm Pronation
Dumbbell Lying Supination => Dumbbell Forearm Supination

# ---- Quads
Dumbbell Lunges => Dumbbell Lunge
Barbell Lunge
Barbell Walking Lunge
Bodyweight Walking Lunge ; type=bodyweight
Dumbbell Squat
Split Squat with Dumbbells => Dumbbell Split Squat
Split Squats => Bodyweight Split Squat ; eq=bodyweight ; type=bodyweight ; mus=quads,glutes,hamstrings
Smith Single-Leg Split Squat => Smith Machine Split Squat ; eq=smith
Box Squat => Barbell Box Squat ; cat=Quads
Wide Stance Barbell Squat => Wide-Stance Barbell Squat
Zercher Squats => Zercher Squat
Narrow Stance Hack Squats => Narrow-Stance Hack Squat
Narrow Stance Leg Press => Narrow-Stance Leg Press
Lying Machine Squat
Barbell Hack Squat
Single-Leg Leg Extension
Barbell Step Ups => Barbell Step-Up
Dumbbell Squat To A Bench => Dumbbell Box Squat
Weighted Sissy Squat => Sissy Squat (Weighted) ; eq=bodyweight ; type=strength
Kettlebell Pistol Squat ; cat=Quads
Front Squats With Two Kettlebells => Double Kettlebell Front Squat ; cat=Quads
Barbell Squat To A Bench => Barbell Squat to Bench

# ---- Hamstrings / Glutes
Standing Leg Curl => Standing Leg Curl (Machine)
Ball Leg Curl => Stability Ball Leg Curl ; eq=other ; type=bodyweight
Smith Machine Stiff-Legged Deadlift => Smith Machine Stiff-Leg Deadlift
Glute Ham Raise => Glute-Ham Raise (GHD) ; cat=Hamstrings ; eq=machine ; type=bodyweight
Kettlebell One-Legged Deadlift => Kettlebell Single-Leg Deadlift ; cat=Hamstrings
Seated Good Mornings => Seated Good Morning ; cat=Hamstrings ; mus=hamstrings,glutes,lower back
Barbell Glute Bridge
Cable Hip Adduction ; cat=Glutes ; mus=adductors
Side Leg Raises => Side-Lying Leg Raise ; eq=bodyweight ; type=bodyweight
Hip Extension with Bands => Band Hip Extension ; eq=band ; type=bodyweight
Hip Flexion with Band => Band Hip Flexion ; eq=band ; type=bodyweight ; cat=Core ; mus=hip flexors,quads
Band Hip Adductions => Band Hip Adduction ; eq=band ; type=bodyweight ; cat=Glutes ; mus=adductors
Physioball Hip Bridge => Stability Ball Hip Bridge ; eq=other ; type=bodyweight ; cat=Glutes ; mus=glutes,hamstrings

# ---- Calves
Smith Machine Calf Raise
Standing Barbell Calf Raise => Barbell Standing Calf Raise
Standing Dumbbell Calf Raise => Dumbbell Standing Calf Raise
Dumbbell Seated One-Leg Calf Raise => Dumbbell Seated Calf Raise (Single-Leg)
Donkey Calf Raises => Donkey Calf Raise ; eq=machine
Barbell Seated Calf Raise
Calf Press => Calf Press Machine
Calf Raises - With Bands => Band Calf Raise ; eq=band ; type=bodyweight
Calf Raise On A Dumbbell => Single-Leg Dumbbell Calf Raise

# ---- Core
Cable Reverse Crunch
Cable Russian Twists => Cable Russian Twist
Cable Seated Crunch => Seated Cable Crunch
Kneeling Cable Crunch With Alternating Oblique Twists => Kneeling Cable Oblique Crunch
One-Arm High-Pulley Cable Side Bends => Cable Side Bend
Pallof Press With Rotation ; mus=abs,obliques
Standing Cable Lift => Cable Lift (Standing) ; mus=abs,obliques
Dumbbell Side Bend
Barbell Side Bend
Knee/Hip Raise On Parallel Bars => Captain's Chair Leg Raise ; eq=other ; type=bodyweight
Decline Crunch ; type=bodyweight
Decline Oblique Crunch
Decline Reverse Crunch
Oblique Crunches => Oblique Crunch
Cross-Body Crunch
Elbow to Knee => Elbow-to-Knee Crunch
Sit-Up
Bent-Knee Hip Raise
Seated Leg Tucks => Seated Leg Tuck
Plate Twist => Weight Plate Twist
Stomach Vacuum ; type=timed
Landmine 180's => Landmine 180 ; mus=obliques,abs,front delts
Exercise Ball Crunch => Stability Ball Crunch ; type=bodyweight
Exercise Ball Pull-In => Stability Ball Pull-In ; type=bodyweight
Hanging Pike
Suspended Fallout => TRX Fallout ; type=bodyweight ; mus=abs,lats,front delts
Barbell Ab Rollout - On Knees => Barbell Rollout (On Knees) ; mus=abs,front delts,lats
Scissor Kick
Spider Crawl ; type=timed ; mus=abs,obliques
Toe Touchers => Toe Touch Crunch
Crunch - Hands Overhead => Overhead Crunch
Crunch - Legs On Exercise Ball => Legs-on-Ball Crunch
Kettlebell Windmill ; cat=Core ; mus=obliques,abs,hamstrings,front delts

# ---- Full body: Olympic, powerlifting, kettlebell, plyo
Clean => Barbell Clean
Hang Clean => Barbell Hang Clean
Power Clean => Barbell Power Clean ; cat=Full Body
Clean and Jerk
Snatch => Barbell Snatch
Power Snatch
Hang Snatch
Power Jerk
Split Jerk
Clean Pull => Barbell Clean Pull
Snatch Pull => Barbell Snatch Pull ; cat=Full Body
Overhead Squat => Barbell Overhead Squat
Dumbbell Clean ; cat=Full Body
One-Arm Kettlebell Swings => One-Arm Kettlebell Swing ; cat=Full Body
Kettlebell Thruster ; cat=Full Body
Kettlebell Sumo High Pull ; cat=Full Body
Kettlebell Halo ; cat=Shoulders
One-Arm Kettlebell Row ; cat=Back
Two-Arm Kettlebell Row ; cat=Back
Two-Arm Kettlebell Military Press => Kettlebell Military Press ; cat=Shoulders
Kettlebell Arnold Press ; cat=Shoulders
One-Arm Kettlebell Push Press => Kettlebell Push Press ; cat=Shoulders
One-Arm Kettlebell Floor Press => Kettlebell Floor Press ; cat=Chest
Alternating Floor Press => Kettlebell Alternating Floor Press ; cat=Chest
Alternating Renegade Row => Kettlebell Renegade Row ; cat=Back
Kettlebell Hang Clean ; cat=Full Body
Kettlebell Seated Press ; cat=Shoulders
Alternating Kettlebell Press ; cat=Shoulders
Kettlebell Turkish Get-Up (Lunge style) => Kettlebell Turkish Get-Up (Lunge Style) ; cat=Full Body
Kettlebell Overhead Triceps Extension ; cat=Triceps
Kettlebell Figure 8 ; cat=Full Body
Standing Long Jump ; type=bodyweight
Lateral Bound ; type=bodyweight ; cat=Glutes
Knee Tuck Jump ; type=bodyweight
Star Jump ; type=bodyweight
Split Jump => Jump Lunge (Split Jump) ; cat=Quads ; type=bodyweight
Bench Jump ; cat=Quads ; type=bodyweight
Depth Jump Leap => Depth Jump ; type=bodyweight
Cable Deadlifts => Cable Deadlift ; cat=Hamstrings ; mus=hamstrings,glutes,quads,lower back

# ---- Cardio (common machines only)
Jogging, Treadmill => Treadmill Jog
Running, Treadmill => Treadmill Run
Recumbent Bike
Step Mill => Stair Mill (Step Mill)

# ---- More variations
Platform Hamstring Slides => Hamstring Slide ; eq=other ; type=bodyweight ; cat=Hamstrings ; mus=hamstrings,glutes
Stiff Leg Barbell Good Morning => Stiff-Leg Good Morning ; cat=Hamstrings ; mus=hamstrings,glutes,lower back
Romanian Deadlift from Deficit => Deficit Romanian Deadlift ; cat=Hamstrings
Wide Stance Stiff Legs => Wide-Stance Stiff-Leg Deadlift ; cat=Hamstrings ; eq=barbell ; type=strength
Hyperextensions With No Hyperextension Bench => Floor Back Extension ; cat=Back ; eq=bodyweight ; type=bodyweight
Weighted Ball Hyperextension => Stability Ball Back Extension ; cat=Back ; eq=other ; type=bodyweight
Standing Palms-Up Barbell Behind The Back Wrist Curl => Behind-the-Back Barbell Wrist Curl
Finger Curls => Barbell Finger Curl
Seated One-Arm Dumbbell Palms-Up Wrist Curl => One-Arm Dumbbell Wrist Curl
Seated One-Arm Dumbbell Palms-Down Wrist Curl => One-Arm Dumbbell Reverse Wrist Curl
Reverse Flyes With External Rotation => Reverse Fly with External Rotation
One-Arm Side Laterals => One-Arm Side Lateral Raise
Alternating Deltoid Raise => Alternating Dumbbell Front Raise
Close-Grip Standing Barbell Curl => Close-Grip Barbell Curl
Flexor Incline Dumbbell Curls => Flexor Incline Dumbbell Curl
Alternate Incline Dumbbell Curl => Alternating Incline Dumbbell Curl
Lying Close-Grip Bar Curl On High Pulley => Lying Cable Bar Curl (High Pulley)
Decline Close-Grip Bench To Skull Crusher => Decline Close-Grip Bench to Skull Crusher
Standing Towel Triceps Extension => Towel Triceps Extension ; type=bodyweight
Close-Grip Push-Up off of a Dumbbell => Close-Grip Push-Up (Hands on Dumbbell)
Wide-Grip Rear Pull-Up => Wide-Grip Pull-Up (Rear) ; type=bodyweight
Side To Side Chins => Side-to-Side Chin-Up ; eq=bodyweight ; type=bodyweight
Elevated Cable Rows => Elevated Cable Row
Shotgun Row => Shotgun Row (Cable)
Full Range-Of-Motion Lat Pulldown => Full-Range Lat Pulldown
Lying Cambered Barbell Row => Lying Barbell Row (Cambered Bar)
Bent Over One-Arm Long Bar Row => Long Bar Row (One-Arm)
Weighted Ball Side Bend => Stability Ball Side Bend ; eq=other
Weighted Crunches => Weighted Crunch
Tuck Crunch
Standing Rope Crunch => Standing Cable Rope Crunch
Rope Crunch => Kneeling Cable Rope Crunch
Flat Bench Leg Pull-In
Barbell Ab Rollout
Suspended Reverse Crunch => TRX Reverse Crunch ; type=bodyweight
Seated Barbell Twist
Jefferson Squats => Jefferson Squat
Suspended Split Squat => TRX Split Squat ; type=bodyweight
Narrow Stance Squats => Narrow-Stance Barbell Squat
Hip Lift with Band => Band Hip Lift ; eq=band ; type=bodyweight ; cat=Glutes ; mus=glutes,hamstrings
One-Arm Kettlebell Clean and Jerk => Kettlebell Clean and Jerk ; cat=Full Body
One-Arm Overhead Kettlebell Squats => Overhead Kettlebell Squat ; cat=Quads
Sled Drag - Harness => Sled Drag (Harness) ; cat=Full Body ; type=strength
Backward Drag => Backward Sled Drag ; cat=Full Body ; type=strength

# ---- Mobility / stretching (kept to ~45 so the list stays usable)
90/90 Hamstring => 90/90 Hamstring Stretch
Adductor/Groin => Adductor Groin Stretch
All Fours Quad Stretch
Ankle Circles
Arm Circles
Behind Head Chest Stretch
Calf Stretch Hands Against Wall => Wall Calf Stretch
Chest And Front Of Shoulder Stretch
Chin To Chest Stretch => Chin-to-Chest Neck Stretch
Dancer's Stretch
Dynamic Chest Stretch
Hamstring Stretch => Standing Hamstring Stretch
Hug Knees To Chest => Hug Knees to Chest
IT Band and Glute Stretch
Intermediate Hip Flexor and Quad Stretch => Hip Flexor and Quad Stretch
Knee Across The Body => Knee-Across-Body Glute Stretch
Kneeling Forearm Stretch
Leg-Up Hamstring Stretch
Lying Bent Leg Groin => Lying Bent-Leg Groin Stretch
Lying Glute => Lying Glute Stretch
Lying Hamstring => Lying Hamstring Stretch
Middle Back Stretch
On Your Side Quad Stretch => Side-Lying Quad Stretch
One Knee To Chest => Knee-to-Chest Stretch
Overhead Stretch => Standing Overhead Stretch
Quad Stretch => Standing Quad Stretch
Round The World Shoulder Stretch
Runner's Stretch
Seated Calf Stretch
Seated Front Deltoid => Seated Front Deltoid Stretch
Seated Glute => Seated Glute Stretch
Seated Hamstring and Calf Stretch
Shoulder Circles
Shoulder Stretch => Cross-Body Shoulder Stretch
Side Neck Stretch
Spinal Stretch => Seated Spinal Twist Stretch
Standing Biceps Stretch
Standing Gastrocnemius Calf Stretch => Standing Calf Stretch (Gastrocnemius)
Standing Hip Flexors => Standing Hip Flexor Stretch
Standing Lateral Stretch => Standing Side Bend Stretch
Standing Soleus And Achilles Stretch => Soleus and Achilles Stretch
The Straddle => Straddle Stretch
Triceps Stretch => Overhead Triceps Stretch
Upper Back Stretch
Wrist Circles
Inchworm ; cat=Mobility ; type=bodyweight ; mus=hamstrings,abs,front delts
"""

# Source records used only to borrow images/level/etc. for hand-written MANUAL entries.

# ---------------------------------------------------------------------------------------
# 3. Helpers
# ---------------------------------------------------------------------------------------
def snake(name):
    s = name.lower().replace("'", '').replace('’', '')
    s = re.sub(r'[^a-z0-9]+', '_', s).strip('_')
    return s

def norm_key(name, strip_grip=True):
    s = name.lower()
    if strip_grip:
        s = re.sub(r'\b(medium|wide|close)\s+grip\b', '', s)
    s = re.sub(r'[^a-z0-9]', '', s)
    return s[:-1] if s.endswith('s') else s

def clean_text(s):
    """Sanitise one line of untrusted source text (plain text only)."""
    s = re.sub(r'[\x00-\x1f\x7f]', ' ', str(s))
    s = re.sub(r'\s+(li|ul|ol|br|p|div|span)>\s*$', '', s)   # stray HTML fragment seen in the source
    s = s.replace('<', '').replace('>', '')
    s = re.sub(r'\s+', ' ', s).strip()
    return s

def strip_balanced(s, marker):
    """Remove a parenthetical that starts with `marker`, honouring nested parentheses."""
    i = s.find(marker)
    if i < 0:
        return s
    depth, j = 0, i
    while j < len(s):
        if s[j] == '(':
            depth += 1
        elif s[j] == ')':
            depth -= 1
            if depth == 0:
                break
        j += 1
    out = (s[:i].rstrip() + ' ' + s[j + 1:].lstrip()).strip()
    return re.sub(r'\.\s*\.+', '.', out)

def tidy_step(s):
    s = clean_text(s)
    s = re.sub(r'\s*\(my prefer(?:ence|red way)\)', '', s)           # author asides in the source
    s = strip_balanced(s, '(Note: For the purposes of this discussion')
    s = re.sub(r'\s*Note: For the purposes of this discussion[^.]*\.', '', s)
    s = re.sub(r'\bI recommend\b', 'We recommend', s)
    s = re.sub(r'\.{2,}$', '.', s)
    if s and s[-1] not in '.!?")':
        s += '.'
    return s

IMG_RE = re.compile(r"^https://raw\.githubusercontent\.com/yuhonas/free-exercise-db/main/exercises/[A-Za-z0-9_\-./%()',]+\.(jpg|png|gif|webp)$")

def img_urls(rec):
    out = []
    for p in (rec.get('images') or [])[:2]:
        p = clean_text(p)
        if not re.match(r"^[A-Za-z0-9_\-./()',]+$", p) or '..' in p:
            continue
        u = IMG_BASE + urllib.parse.quote(p, safe="/()',-_.")
        if IMG_RE.match(u):
            out.append(u)
    return out

def steps_of(rec):
    return [t for t in (tidy_step(i) for i in rec.get('instructions') or []) if t]

def src_level(rec):
    v = rec.get('level')
    return v if v in LEVELS else None

ISO_RE = re.compile(r'\b(fly|flye|flyes|curl|raise|extension|pushdown|kickback|shrug|wrist|calf|rotation|pullover|crossover|side bend|abduction|adduction)\b', re.I)
COMP_RE = re.compile(r'\b(row|press|squat|deadlift|lunge|pull-up|chin-up|dip|push-up|clean|snatch|jerk|thruster|bridge|thrust)\b', re.I)

def fix_mechanic(name, v):
    """The source mislabels a handful of moves; a name-based sanity check wins over it."""
    if ISO_RE.search(name) and not COMP_RE.search(name):
        return 'isolation'
    if COMP_RE.search(name) and not ISO_RE.search(name) and v is None:
        return 'compound'
    return v

def src_mechanic(rec, name=None):
    v = rec.get('mechanic')
    v = v if v in MECHS else None
    return fix_mechanic(name, v) if name else v

def src_force(rec):
    v = rec.get('force')
    return v if v in FORCES else None

def extra_fields(rec, cat, name=None):
    """steps/img/level/mechanic/force taken from a source record (insertion order matters)."""
    out = OrderedDict()
    st = steps_of(rec) or [tidy_step(t) for t in STEP_FALLBACK.get(rec.get('name'), [])]
    if st:
        out['steps'] = st
    im = img_urls(rec)
    if im:
        out['img'] = im
    if cat == 'Mobility':
        out['level'] = 'beginner'      # source levels on stretches are noise
    elif src_level(rec):
        out['level'] = src_level(rec)
    if cat not in ('Mobility', 'Cardio'):
        if src_mechanic(rec, name):
            out['mechanic'] = src_mechanic(rec, name)
        if src_force(rec):
            out['force'] = src_force(rec)
    elif cat == 'Mobility':
        out['force'] = 'static'
    return out

# ---- muscles --------------------------------------------------------------------------
DIRECT_MUSCLE = {'abdominals': 'abs', 'quadriceps': 'quads', 'middle back': 'upper back', 'neck': 'traps',
                 'abductors': 'glutes', 'biceps': 'biceps', 'triceps': 'triceps', 'forearms': 'forearms',
                 'chest': 'chest', 'lats': 'lats', 'lower back': 'lower back', 'traps': 'traps',
                 'glutes': 'glutes', 'hamstrings': 'hamstrings', 'adductors': 'adductors', 'calves': 'calves'}

def shoulder_for(name, rec, primary):
    n = name.lower()
    if re.search(r'lateral|side raise|side laterals?|upright', n):
        return 'side delts'
    if re.search(r'rear|reverse|face pull|bent[- ]over', n):
        return 'rear delts'
    if primary != 'shoulders' and src_force(rec) == 'pull':
        return 'rear delts'     # secondary shoulders on a pulling move (rows, pulldowns, curls)
    return 'front delts'

def map_muscles(rec, name):
    n = name.lower()
    out = []
    def add(m):
        if m not in out:
            out.append(m)
    prim = [p.lower() for p in rec.get('primaryMuscles') or []]
    sec = [s.lower() for s in rec.get('secondaryMuscles') or []]
    for i, m in enumerate(prim + sec):
        if m == 'shoulders':
            add(shoulder_for(name, rec, prim[0] if prim else ''))
            if i == 0 and re.search(r'press', n) and 'front' in out[-1]:
                add('side delts')
        elif m in DIRECT_MUSCLE:
            add(DIRECT_MUSCLE[m])
    if re.search(r'twist|oblique|side bend|side bridge|woodchop|wood chop|windmill|side plank', n):
        if 'obliques' not in out:
            out.insert(1 if out else 0, 'obliques')
    return out[:5]

CORE_OK = {'abs', 'obliques', 'hip flexors', 'lower back', 'glutes', 'front delts', 'hamstrings', 'lats'}

def tidy_muscles(m, mech, section=''):
    """Source secondary-muscle lists are generous; keep what a lifter would actually expect."""
    if not m:
        return m
    if section == 'Mobility':
        return m[:3]
    if m[0] in ('abs', 'obliques', 'hip flexors'):
        return [m[0]] + [x for x in m[1:] if x in CORE_OK][:2]
    if mech == 'isolation':
        if m[0] == 'triceps':
            return ['triceps']
        if m[0] == 'biceps':
            return ['biceps'] + (['forearms'] if 'forearms' in m else [])
        return m[:2]
    if m[0] in ('quads', 'hamstrings', 'glutes') and len(m) > 3 and 'calves' in m:
        m = [x for x in m if x != 'calves']
    return m[:5]

# ---- equipment / category / type ------------------------------------------------------
EQ_MAP = {'body only': 'bodyweight', 'kettlebells': 'kettlebell', 'bands': 'band', 'e-z curl bar': 'barbell',
          'medicine ball': 'other', 'exercise ball': 'other', 'foam roll': 'other', 'other': 'other',
          'machine': 'machine', 'cable': 'cable', 'barbell': 'barbell', 'dumbbell': 'dumbbell'}

def map_equipment(rec, name):
    if 'smith' in name.lower():
        return 'smith'
    e = rec.get('equipment')
    if e is None:
        # deviation from "null -> other": null in the source means "no equipment", i.e. bodyweight
        return 'none' if rec.get('category') == 'cardio' else 'bodyweight'
    m = EQ_MAP.get(e, 'other')
    if m == 'other' and 'plate' in rec.get('name', '').lower():
        m = 'plate'
    return m

CAT_OF_MUSCLE = {'chest': 'Chest', 'lats': 'Back', 'upper back': 'Back', 'traps': 'Back', 'lower back': 'Back',
                 'front delts': 'Shoulders', 'side delts': 'Shoulders', 'rear delts': 'Shoulders',
                 'biceps': 'Biceps', 'triceps': 'Triceps', 'forearms': 'Forearms', 'quads': 'Quads',
                 'hamstrings': 'Hamstrings', 'glutes': 'Glutes', 'adductors': 'Glutes', 'calves': 'Calves',
                 'abs': 'Core', 'obliques': 'Core', 'hip flexors': 'Core'}

def map_cat(rec, muscles, section=''):
    c = rec.get('category')
    if c == 'cardio':
        return 'Cardio'
    if c == 'stretching' and section == 'Mobility':
        return 'Mobility'
    if c in ('olympic weightlifting', 'strongman', 'plyometrics'):
        return 'Full Body'
    return CAT_OF_MUSCLE.get(muscles[0], 'Full Body') if muscles else 'Full Body'

TIMED_RE = re.compile(r'\b(plank|hold|dead hang|wall sit|isometric|vacuum|pinch|bear crawl|carry)\b|\bhang$', re.I)
CARDIO_MET = {'Treadmill Jog': 7, 'Treadmill Run': 9, 'Recumbent Bike': 5.5, 'Stair Mill (Step Mill)': 9,
              'Spin Bike (Indoor Cycling)': 8.5}

def decide_type(cat, eq, name):
    if cat == 'Cardio':
        return 'cardio'
    if cat == 'Mobility':
        return 'timed'
    if TIMED_RE.search(name):
        return 'timed'
    if eq in ('bodyweight', 'band'):
        return 'bodyweight'
    return 'strength'

def decide_met(cat, eq, typ, mech, muscles, src_cat, name):
    if cat == 'Mobility':
        return 2.5
    if cat == 'Cardio':
        return CARDIO_MET.get(name, 7)
    if src_cat in ('olympic weightlifting', 'plyometrics'):
        return 6
    if typ in ('bodyweight', 'timed') and eq in ('bodyweight', 'band', 'other', 'none'):
        return 4 if mech == 'compound' else 3.5
    if mech == 'compound':
        if eq == 'barbell' and muscles and muscles[0] in ('quads', 'hamstrings', 'glutes', 'lower back'):
            return 6
        return 5
    return 3.5

# ---- keywords (search aliases, incl. Indian gym slang) --------------------------------
EQ_KW = {'barbell': ['barbell', 'bb', 'rod'], 'dumbbell': ['dumbbell', 'db', 'dumbell'], 'machine': ['machine'],
         'cable': ['cable', 'pulley'], 'smith': ['smith machine', 'smith'], 'band': ['resistance band', 'band'],
         'kettlebell': ['kettlebell', 'kb'], 'plate': ['plate'], 'bodyweight': ['bodyweight'], 'other': [], 'none': []}
MUSCLE_KW = {'chest': ['chest', 'pecs'], 'lats': ['lats', 'back'], 'upper back': ['back', 'rhomboids'],
             'traps': ['traps'], 'lower back': ['lower back'], 'front delts': ['shoulders', 'delts'],
             'side delts': ['shoulders', 'delts'], 'rear delts': ['rear delts', 'shoulders'],
             'biceps': ['biceps', 'bicep'], 'triceps': ['triceps', 'tricep'], 'forearms': ['forearms', 'grip'],
             'abs': ['abs', 'core'], 'obliques': ['obliques'], 'hip flexors': ['hip flexors'],
             'quads': ['quads', 'legs'], 'hamstrings': ['hamstrings', 'legs'], 'glutes': ['glutes'],
             'adductors': ['inner thigh'], 'calves': ['calves', 'legs']}
DAY_KW = {'Chest': 'chest day', 'Back': 'back day', 'Shoulders': 'shoulder day', 'Biceps': 'arm day',
          'Triceps': 'arm day', 'Forearms': 'forearms', 'Quads': 'leg day', 'Hamstrings': 'leg day',
          'Glutes': 'leg day', 'Calves': 'leg day', 'Core': 'abs workout', 'Cardio': 'cardio',
          'Mobility': 'stretch', 'Full Body': 'full body'}
NICK = [
    (r'pec deck|butterfly', ['pec deck', 'butterfly', 'pec fly']),
    (r'chest press|bench press', ['chest press', 'press']),
    (r'cable (fly|crossover)|crossover', ['cable fly', 'crossover']),
    (r'\bfly\b|flye', ['fly', 'flyes']),
    (r'hammer strength|plate-loaded|leverage', ['hammer strength', 'plate loaded']),
    (r'pulldown|pull-down', ['pulldown', 'lat pull', 'lats']),
    (r'pull-up|pullup|chin-up', ['pull up', 'chin up', 'lats']),
    (r'\brow\b', ['row', 'back']),
    (r'shrug', ['shrug', 'traps']),
    (r'lateral raise|side raise', ['lateral raise', 'side delts', 'shoulder']),
    (r'rear delt|reverse fly|face pull', ['rear delts', 'back shoulder']),
    (r'shoulder press|military press|overhead press', ['shoulder press', 'ohp']),
    (r'curl', ['curl']),
    (r'pushdown|extension', ['triceps']),
    (r'\bdip', ['dips', 'dip']),
    (r'leg press', ['leg press', 'legs']),
    (r'leg curl|hamstring curl', ['leg curl', 'hamstring curl']),
    (r'leg extension', ['leg extension', 'quads']),
    (r'squat', ['squat', 'legs']),
    (r'lunge|split squat', ['lunge', 'legs']),
    (r'deadlift', ['deadlift']),
    (r'hip thrust|glute bridge|kickback|abductor|adductor', ['glutes', 'booty']),
    (r'calf', ['calf raise', 'calves']),
    (r'crunch|sit-up|leg raise|knee raise|twist|woodchop|wood chop|side bend', ['abs', 'core']),
    (r'treadmill|jog|run', ['treadmill', 'running', 'cardio']),
    (r'bike|cycle|cycling', ['cycle', 'bike', 'cardio']),
    (r'stretch', ['stretch', 'flexibility']),
    (r'hyperextension|back extension', ['back extension', 'hyper', 'lower back']),
    (r'push-up|pushup', ['pushup', 'push up']),
    (r'clean|snatch|jerk', ['olympic lift', 'weightlifting']),
    (r'kettlebell', ['kettlebell', 'kb']),
]

def make_kw(name, cat, eq, muscles, extra=None):
    out = []
    def add(k):
        k = re.sub(r'\s+', ' ', k.lower().strip())
        if k and k not in out and re.match(r"^[a-z0-9][a-z0-9 /'-]*$", k):
            out.append(k)
    for k in (extra or []):
        add(k)
    base = re.sub(r'\s*\([^)]*\)', '', name).lower()
    base = base.replace('-', ' ')
    add(base)
    for m in re.findall(r'\(([^)]*)\)', name):
        add(m.replace('-', ' '))
    n = name.lower()
    for rx, kws in NICK:
        if re.search(rx, n):
            for k in kws:
                add(k)
    for k in EQ_KW.get(eq, []):
        add(k)
    for m in muscles[:2]:
        for k in MUSCLE_KW.get(m, [])[:2]:
            add(k)
    add(DAY_KW.get(cat, ''))
    out = out[:8]
    for m in muscles:
        if len(out) >= 3:
            break
        add(m)
        out = out[:8]
    return out[:8]

# ---------------------------------------------------------------------------------------
# 4. Build
# ---------------------------------------------------------------------------------------
def parse_new_text():
    """-> list of (source_name, new_name, overrides dict, section)"""
    out, section = [], ''
    for raw in NEW_TEXT.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith('#'):
            section = line.lstrip('# -').split()[0] if line.lstrip('# -') else section
            continue
        parts = [p.strip() for p in line.split(';')]
        head, ovr = parts[0], {}
        for p in parts[1:]:
            k, _, v = p.partition('=')
            ovr[k.strip()] = v.strip()
        if '=>' in head:
            src, new = [x.strip() for x in head.split('=>', 1)]
        else:
            src = new = head
        out.append((src, new, ovr, section))
    return out

def build_new_from_source(src_by_name):
    recs = []
    for src_name, new_name, ovr, section in parse_new_text():
        rec = src_by_name.get(src_name)
        if rec is None:
            raise SystemExit('NEW_TEXT references a source record that does not exist: %r' % src_name)
        muscles = ovr['mus'].split(',') if 'mus' in ovr else map_muscles(rec, new_name)
        muscles = [m.strip() for m in muscles]
        if 'mus' not in ovr:
            muscles = tidy_muscles(muscles, src_mechanic(rec, new_name), section)
        cat = ovr.get('cat') or ('Mobility' if section == 'Mobility' else map_cat(rec, muscles, section))
        eq = ovr.get('eq') or map_equipment(rec, new_name)
        if section == 'Mobility' and eq == 'other' and 'eq' not in ovr:
            eq = 'bodyweight'
        typ = ovr.get('type') or decide_type(cat, eq, new_name)
        mech = src_mechanic(rec, new_name)
        if mech is None and cat not in ('Mobility', 'Cardio'):
            mech = 'compound' if len(rec.get('secondaryMuscles') or []) >= 2 else 'isolation'
        met = float(ovr['met']) if 'met' in ovr else decide_met(cat, eq, typ, mech, muscles,
                                                                 rec.get('category'), new_name)
        met = int(met) if float(met).is_integer() else met
        r = OrderedDict()
        r['id'] = snake(new_name)
        r['name'] = new_name
        r['cat'] = cat
        r['muscles'] = muscles
        r['equipment'] = eq
        r['type'] = typ
        r['met'] = met
        r['_kw'] = (muscles, eq)
        ex = extra_fields(rec, cat, new_name)
        if mech and cat not in ('Mobility', 'Cardio'):
            ex['mechanic'] = mech
        r['_extra'] = ex
        r['_src'] = src_name
        recs.append(r)
    return recs

def build_manual(src_by_name):
    recs = []
    for m in MANUAL:
        r = OrderedDict()
        r['id'] = snake(m['name'])
        r['name'] = m['name']
        r['cat'] = m['cat']
        r['muscles'] = list(m['mus'])
        r['equipment'] = m['eq']
        r['type'] = m['type']
        r['met'] = m['met']
        r['_kw'] = (r['muscles'], m['eq'])
        ex = OrderedDict()
        ex['steps'] = [tidy_step(s) for s in m['steps']]
        src = src_by_name.get(m['src']) if m.get('src') else None
        if m.get('src') and src is None:
            raise SystemExit('MANUAL src not found: %r' % m['src'])
        if src is not None:
            im = img_urls(src)
            if im:
                ex['img'] = im
        ex['level'] = m['level']
        if m.get('mech'):
            ex['mechanic'] = m['mech']
        if m.get('force'):
            ex['force'] = m['force']
        r['_extra'] = ex
        r['_src'] = m.get('src') or '(hand-written)'
        r['_manual'] = True
        recs.append(r)
    return recs

def finish_record(r):
    """Assemble final key order: id,name,cat,muscles,equipment,type,met,[cues,mistakes],kw,steps,img,level,mechanic,force"""
    out = OrderedDict()
    for k in ('id', 'name', 'cat', 'muscles', 'equipment', 'type', 'met'):
        out[k] = r[k]
    c = CUES.get(r['id'])
    if c:
        out['cues'], out['mistakes'] = list(c[0]), list(c[1])
    muscles, eq = r['_kw']
    out['kw'] = make_kw(r['name'], r['cat'], eq, muscles, KW_EXTRA.get(r['id']))
    for k, v in r['_extra'].items():
        out[k] = v
    if r['id'] in STEP_OVERRIDE:
        out['steps'] = [tidy_step(t) for t in STEP_OVERRIDE[r['id']]]
    return out

def main():
    if len(sys.argv) != 2:
        raise SystemExit('usage: build-exercises.py <path-to-free-exercise-db-dist-exercises.json>')
    with open(sys.argv[1], encoding='utf-8') as f:
        source = json.load(f)
    src_by_name = {}
    for rec in source:
        if isinstance(rec, dict) and isinstance(rec.get('name'), str):
            src_by_name[rec['name']] = rec
    with open(DATA, encoding='utf-8') as f:
        current = json.load(f, object_pairs_hook=OrderedDict)
    if len(current) < BASE_COUNT:
        raise SystemExit('exercises.json has fewer than %d entries' % BASE_COUNT)
    base = current[:BASE_COUNT]
    if base[0]['id'] != 'barbell_bench_press' or base[-1]['id'] != 'pigeon_pose':
        raise SystemExit('first %d entries are not the original catalogue; refusing to rebuild' % BASE_COUNT)
    base_ids = {e['id'] for e in base}

    # ---- 1. enrich existing -------------------------------------------------------------
    src_keys = {}
    for n in src_by_name:
        src_keys.setdefault(norm_key(n), n)
    enriched, matched_src, via_manual = [], set(), 0
    stats = Counter()
    for e in base:
        before = json.dumps(e, sort_keys=True, ensure_ascii=False)
        e2 = OrderedDict((k, v) for k, v in e.items() if k not in ('steps', 'img', 'level', 'mechanic', 'force'))
        sname = ALIASES.get(e['id']) or src_keys.get(norm_key(e['name']))
        if ALIASES.get(e['id']) and ALIASES[e['id']] not in src_by_name:
            raise SystemExit('ALIASES points at missing source record: %r' % ALIASES[e['id']])
        if sname:
            matched_src.add(sname)
            for k, v in extra_fields(src_by_name[sname], e['cat'], e['name']).items():
                e2[k] = v
            stats['alias' if e['id'] in ALIASES else 'auto'] += 1
        elif e['id'] in EXISTING_STEPS:
            st, lvl, mech, force = EXISTING_STEPS[e['id']]
            e2['steps'] = [tidy_step(s) for s in st]
            e2['level'] = lvl
            if mech:
                e2['mechanic'] = mech
            if force:
                e2['force'] = force
            via_manual += 1
        # original keys untouched?
        for k in ('id', 'name', 'cat', 'muscles', 'equipment', 'type', 'met', 'cues', 'mistakes', 'kw'):
            if e.get(k) != e2.get(k):
                raise SystemExit('internal error: original field changed for %s.%s' % (e['id'], k))
        if e['id'] in STEP_OVERRIDE:
            e2['steps'] = [tidy_step(t) for t in STEP_OVERRIDE[e['id']]]
        enriched.append(e2)

    # ---- 2. new exercises ---------------------------------------------------------------
    new = build_new_from_source(src_by_name) + build_manual(src_by_name)
    taken = set(base_ids)
    seen_names = {norm_key(e['name'], False) for e in base}
    final_new = []
    for r in new:
        nk = norm_key(r['name'], False)
        if nk in seen_names:
            print('  skipped near-duplicate name:', r['name'])
            continue
        seen_names.add(nk)
        i, base_id = r['id'], r['id']
        n = 2
        while i in taken:
            i = '%s_%d' % (base_id, n)
            n += 1
        r['id'] = i
        taken.add(i)
        final_new.append(r)
    final_new.sort(key=lambda r: (CATS.index(r['cat']), r['name'].lower()))
    new_recs = [finish_record(r) for r in final_new]

    unknown_cues = [k for k in CUES if k not in taken]
    if unknown_cues:
        raise SystemExit('CUES keys that match no exercise id: %s' % unknown_cues)
    unknown_kw = [k for k in KW_EXTRA if k not in taken]
    if unknown_kw:
        raise SystemExit('KW_EXTRA keys that match no exercise id: %s' % unknown_kw)
    unknown_over = [k for k in STEP_OVERRIDE if k not in taken]
    if unknown_over:
        raise SystemExit('STEP_OVERRIDE keys that match no exercise id: %s' % unknown_over)
    unknown_steps = [k for k in EXISTING_STEPS if k not in base_ids]
    if unknown_steps:
        raise SystemExit('EXISTING_STEPS keys that are not original ids: %s' % unknown_steps)

    result = enriched + new_recs
    problems = validate(result)
    if problems:
        print('VALIDATION FAILED:')
        for p in problems[:40]:
            print('  -', p)
        raise SystemExit(1)

    out_path = os.environ.get('EXERCISES_OUT') or DATA   # EXERCISES_OUT lets you preview without touching the real file
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=1, ensure_ascii=False)
        f.write('\n')
    print('wrote', out_path)
    summary(result, enriched, new_recs, stats, via_manual)

def validate(data):
    bad = []
    ids = set()
    for idx, e in enumerate(data):
        i = e.get('id')
        if not i or not re.match(r'^[a-z0-9_]+$', i):
            bad.append('bad id %r' % i)
        if i in ids:
            bad.append('duplicate id %s' % i)
        ids.add(i)
        for k in ('name', 'cat', 'muscles', 'equipment', 'type', 'met'):
            if e.get(k) in (None, '', []):
                bad.append('%s missing %s' % (i, k))
        if e.get('cat') not in CATS:
            bad.append('%s bad cat %r' % (i, e.get('cat')))
        if e.get('equipment') not in EQUIP:
            bad.append('%s bad equipment %r' % (i, e.get('equipment')))
        if e.get('type') not in TYPES:
            bad.append('%s bad type %r' % (i, e.get('type')))
        if not isinstance(e.get('met'), (int, float)) or not (1 <= e['met'] <= 15):
            bad.append('%s bad met %r' % (i, e.get('met')))
        for m in e.get('muscles') or []:
            if m not in MUSCLES:
                bad.append('%s bad muscle %r' % (i, m))
        if len(set(e.get('muscles') or [])) != len(e.get('muscles') or []):
            bad.append('%s duplicate muscles' % i)
        for u in e.get('img') or []:
            if not IMG_RE.match(u):
                bad.append('%s malformed img url %r' % (i, u))
        if len(e.get('img') or []) > 2:
            bad.append('%s too many images' % i)
        if 'level' in e and e['level'] not in LEVELS:
            bad.append('%s bad level' % i)
        if 'mechanic' in e and e['mechanic'] not in MECHS:
            bad.append('%s bad mechanic' % i)
        if 'force' in e and e['force'] not in FORCES:
            bad.append('%s bad force' % i)
        kw = e.get('kw')
        if idx >= BASE_COUNT and (kw is None or not (3 <= len(kw) <= 8)):
            bad.append('%s kw count %r' % (i, kw))   # the original entries keep their own (shorter) kw lists
        if 'steps' in e and (not e['steps'] or not all(isinstance(s, str) and s for s in e['steps'])):
            bad.append('%s bad steps' % i)
        if 'cues' in e and len(e['cues']) != 3:
            bad.append('%s needs exactly 3 cues' % i)
        if 'mistakes' in e and len(e['mistakes']) != 2:
            bad.append('%s needs exactly 2 mistakes' % i)
        for s in (e.get('steps') or []) + (e.get('cues') or []) + (e.get('mistakes') or []) + [e.get('name', '')]:
            if re.search(r'[<>]', s):
                bad.append('%s markup characters in text' % i)
    return bad

def summary(result, enriched, new_recs, stats, via_manual):
    print('total exercises: %d  (original %d + new %d)' % (len(result), len(enriched), len(new_recs)))
    print('per category :', ', '.join('%s %d' % (c, n) for c, n in sorted(Counter(e['cat'] for e in result).items(), key=lambda x: CATS.index(x[0]))))
    print('per equipment:', ', '.join('%s %d' % kv for kv in Counter(e['equipment'] for e in result).most_common()))
    print('per type     :', ', '.join('%s %d' % kv for kv in Counter(e['type'] for e in result).most_common()))
    got_steps = sum(1 for e in enriched if 'steps' in e)
    got_img = sum(1 for e in enriched if 'img' in e)
    print('existing exercises with steps: %d (source match %d, hand-written %d); with img: %d'
          % (got_steps, stats['alias'] + stats['auto'], via_manual, got_img))
    print('new exercises: %d  with steps %d, img %d, cues %d'
          % (len(new_recs), sum('steps' in e for e in new_recs), sum('img' in e for e in new_recs), sum('cues' in e for e in new_recs)))
    print('all exercises: steps %d, img %d, cues %d' % (sum('steps' in e for e in result), sum('img' in e for e in result), sum('cues' in e for e in result)))

# ---------------------------------------------------------------------------------------
# 5. Hand-written data
# ---------------------------------------------------------------------------------------
# Source records that ship with no instructions at all.
STEP_FALLBACK = {
    'One-Arm Kettlebell Swings': [
        'Stand with feet slightly wider than shoulder width and a kettlebell on the floor about a foot in front of you.',
        'Hinge at the hips with a flat back and grip the handle with one hand, then hike the bell back between your legs.',
        'Drive your hips forward explosively so the kettlebell swings up to chest height, with your arm acting as a rope.',
        'At the top, stand tall with glutes squeezed, then let the bell fall and hinge back so it swings between your legs again.',
        'Complete your reps on one side and switch hands, keeping your back flat throughout.',
    ],
    'Push Press': [
        'Rack the barbell on your front shoulders with a shoulder-width grip, elbows slightly in front of the bar and feet hip-width apart.',
        'Dip a few inches by bending your knees, keeping your torso upright.',
        'Drive up explosively through your legs and use that momentum to press the bar overhead.',
        'Lock out with the bar over the middle of your feet and your biceps near your ears.',
        'Lower the bar back to your shoulders while bending your knees to absorb it.',
    ],
    'Side Bridge': [
        'Lie on your side with your legs straight and your forearm on the floor under your shoulder.',
        'Brace your abs and lift your hips so your body forms a straight line from head to feet.',
        'Hold this position without letting your hips sag or rotate, breathing steadily.',
        'Lower your hips with control and repeat on the other side.',
    ],
}

# Machine / cable checklist items (and a few popular extras) the source does not have.
# src = a source record used only to borrow its start/end images.
def M(name, cat, mus, eq, typ, met, level, mech, force, steps, src=None):
    return dict(name=name, cat=cat, mus=mus, eq=eq, type=typ, met=met, level=level, mech=mech,
                force=force, steps=steps, src=src)

MANUAL = [
    M('Machine Lateral Raise', 'Shoulders', ['side delts', 'traps'], 'machine', 'strength', 3.5, 'beginner', 'isolation', 'push', [
        'Adjust the seat so your shoulders line up with the pivot of the machine, then sit tall with your back against the pad.',
        'Place your forearms (or hands) on the pads with your elbows bent to about 90 degrees.',
        'Raise your arms out to the sides, leading with your elbows, until your upper arms are roughly parallel to the floor.',
        'Pause for a second at the top without shrugging your shoulders toward your ears.',
        'Lower the pads slowly and stop just short of letting the weight stack rest so the tension stays on your side delts.']),
    M('Smith Machine Shrug', 'Back', ['traps', 'forearms'], 'smith', 'strength', 3.5, 'beginner', 'isolation', 'pull', [
        'Set the bar at about mid-thigh height, load it, and stand tall in front of it with your feet hip-width apart.',
        'Grip the bar slightly wider than shoulder width with an overhand grip and unrack it by rotating your wrists.',
        'With your arms straight and chest up, shrug your shoulders straight up toward your ears as high as you can.',
        'Hold the top for one second, then lower slowly until you feel a full stretch in your traps.',
        'Rotate the bar back onto the hooks when your set is done.']),
    M('Seated Cable Row (Wide Grip)', 'Back', ['upper back', 'lats', 'rear delts', 'biceps'], 'cable', 'strength', 5, 'beginner', 'compound', 'pull', [
        'Attach a wide bar to the low pulley, sit on the bench with your feet braced on the platform and knees slightly bent.',
        'Grip the bar with an overhand grip a little wider than shoulder width and sit tall with a flat back.',
        'Pull the bar to your lower chest by driving your elbows out and back and squeezing your shoulder blades together.',
        'Pause briefly at the end of the pull without leaning back past vertical.',
        'Extend your arms slowly until you feel a stretch across your upper back, keeping your torso steady.'], src='Seated Cable Rows'),
    M('Seated Cable Row (V-Bar)', 'Back', ['lats', 'upper back', 'biceps', 'rear delts'], 'cable', 'strength', 5, 'beginner', 'compound', 'pull', [
        'Attach the V-bar (close neutral-grip handle) to the low pulley and sit with your feet braced and knees slightly bent.',
        'Grab the handle with your palms facing each other and sit upright with your chest up and lower back neutral.',
        'Pull the handle to your belly button, keeping your elbows close to your sides.',
        'Squeeze your shoulder blades together for a second at the end of the pull.',
        'Return slowly until your arms are straight, letting your shoulder blades stretch forward without rounding your lower back.'], src='Seated Cable Rows'),
    M('Assisted Dip Machine', 'Triceps', ['triceps', 'chest', 'front delts'], 'machine', 'strength', 3.5, 'beginner', 'compound', 'push', [
        'Select the assistance weight (a heavier pin makes the dip easier), then step onto the kneeling pad or footrest.',
        'Grip the handles with your arms straight and your shoulders pulled down away from your ears.',
        'Bend your elbows to lower your body under control; stay upright for triceps or lean slightly forward for more chest.',
        'Lower until your upper arms are about parallel to the floor, or until you feel a comfortable stretch in your chest.',
        'Press through your palms to straighten your arms without slamming your elbows into lockout.']),
    M('Leg Press (45 Degree)', 'Quads', ['quads', 'glutes', 'hamstrings', 'adductors'], 'machine', 'strength', 5, 'beginner', 'compound', 'push', [
        'Adjust the backrest so your knees can bend to about 90 degrees, then sit with your back and hips flat against the pad.',
        'Place your feet shoulder-width apart in the middle of the platform with your toes turned out slightly, and release the safety handles.',
        'Lower the sled slowly until your knees reach about 90 degrees, keeping your hips and lower back pressed into the seat.',
        'Drive through your whole foot to push the platform up without letting your knees cave inward.',
        'Stop just short of locking your knees, and re-engage the safety stops when you finish the set.'], src='Leg Press'),
    M('Horizontal Leg Press (Seated)', 'Quads', ['quads', 'glutes', 'hamstrings', 'adductors'], 'machine', 'strength', 5, 'beginner', 'compound', 'push', [
        'Sit in the seat and slide it so your knees are bent to about 90 degrees with both feet flat on the footplate.',
        'Place your feet shoulder-width apart, grip the side handles, and press out slightly to release the safety.',
        'Bend your knees to bring the footplate toward you without letting your hips lift off the seat.',
        'Push the plate away by driving through your heels and mid-foot until your legs are almost straight.',
        'Keep your knees in line with your toes and do not lock out hard at the top.']),
    M('Leg Press (Wide Stance)', 'Glutes', ['glutes', 'adductors', 'quads', 'hamstrings'], 'machine', 'strength', 5, 'beginner', 'compound', 'push', [
        'Sit in the leg press with your back and hips flat on the pad and place your feet high and wide on the platform with toes turned out slightly.',
        'Release the safety handles and lower the platform until your knees are near 90 degrees, with your knees tracking over your toes.',
        'Keep your lower back on the pad; if your hips roll up, shorten your range of motion.',
        'Drive through your heels and the outside of your feet to press up, stopping before lockout.',
        'Re-engage the safety stops at the end of the set.']),
    M('Leg Press (Single-Leg)', 'Quads', ['quads', 'glutes', 'hamstrings'], 'machine', 'strength', 5, 'intermediate', 'compound', 'push', [
        'Sit in the leg press and place one foot in the centre of the platform, with the other foot resting on the floor or the side of the sled.',
        'Release the safety and lower the platform until your working knee is bent to about 90 degrees.',
        'Keep your hips level and your knee in line with your toes.',
        'Press the platform back up through your heel and mid-foot without locking out.',
        'Finish all reps on one leg, then switch legs.']),
    M('Pendulum Squat', 'Quads', ['quads', 'glutes'], 'machine', 'strength', 5, 'intermediate', 'compound', 'push', [
        'Set the shoulder pads to your height, step onto the platform with your feet shoulder-width apart, and rest your back against the pad.',
        'Place your shoulders under the pads, hold the handles, and unlock the safety.',
        'Bend your knees and sit down along the arc of the machine until your thighs are at least parallel to the platform.',
        'Keep your chest up and your heels flat as the platform swings.',
        'Drive up through your whole foot to stand, stopping just before your knees lock out.']),
    M('Glute Kickback Machine', 'Glutes', ['glutes', 'hamstrings'], 'machine', 'strength', 3.5, 'beginner', 'isolation', 'push', [
        'Adjust the machine so the pad sits on the back of your working leg and your chest rests on the support pad.',
        'Hold the handles to stay steady and keep your hips square to the machine.',
        'Squeeze your glute to push your leg back and slightly up until your hip is fully extended.',
        'Pause for a second at the top without arching your lower back.',
        'Return slowly until you feel a stretch in your glute, and finish all reps before switching legs.']),
    M('Hip Thrust Machine', 'Glutes', ['glutes', 'hamstrings', 'adductors'], 'machine', 'strength', 5, 'beginner', 'compound', 'push', [
        'Sit on the floor with your upper back against the pad and fasten the belt or lever across your hips as the machine requires.',
        'Place your feet flat and shoulder-width apart so your shins are close to vertical at the top of the lift.',
        'Brace your abs and drive through your heels to lift your hips until your torso is in line with your thighs.',
        'Squeeze your glutes hard at the top and keep your chin slightly tucked.',
        'Lower your hips under control and drive up again.']),
    M('Smith Machine Hip Thrust', 'Glutes', ['glutes', 'hamstrings'], 'smith', 'strength', 5, 'intermediate', 'compound', 'push', [
        'Place a bench behind you inside the Smith machine, sit on the floor with your upper back against the bench, and roll the bar (with a pad) into your hip crease.',
        'Plant your feet flat, about shoulder-width apart, and rotate your wrists to unlock the bar.',
        'Drive through your heels to lift your hips until your torso is parallel to the floor and your shins are vertical.',
        'Squeeze your glutes at the top without over-arching your lower back.',
        'Lower under control, and re-rack the bar when you finish.']),
    M('Cable Hip Abduction', 'Glutes', ['glutes'], 'cable', 'strength', 3.5, 'beginner', 'isolation', 'push', [
        'Attach an ankle cuff to a low pulley and strap it to the ankle that is farther from the stack, then stand sideways holding the frame for balance.',
        'Stand tall with your core braced and a soft bend in your standing knee.',
        'Lift your working leg out to the side, leading with the heel, until you feel a squeeze in your outer glute.',
        'Pause briefly at the top without leaning your torso.',
        'Lower slowly while keeping tension on the cable, and finish all reps before switching sides.']),
    M('Dumbbell Hip Thrust', 'Glutes', ['glutes', 'hamstrings'], 'dumbbell', 'strength', 5, 'beginner', 'compound', 'push', [
        'Sit on the floor with your upper back against the edge of a bench and a dumbbell resting on your hip crease, held with both hands.',
        'Plant your feet flat and hip-width apart with your knees bent.',
        'Drive through your heels to lift your hips until your torso is parallel to the floor.',
        'Squeeze your glutes at the top and keep your ribs down.',
        'Lower your hips slowly and repeat.']),
    M('Single-Leg Hip Thrust', 'Glutes', ['glutes', 'hamstrings'], 'bodyweight', 'bodyweight', 4, 'intermediate', 'compound', 'push', [
        'Sit on the floor with your upper back against a bench, plant one foot flat, and extend the other leg or hold the knee toward your chest.',
        'Drive through the heel of the planted foot to lift your hips until your torso is level with the floor.',
        'Keep your hips square and avoid twisting.',
        'Squeeze your glute for a second at the top, lower under control, and finish all reps before switching sides.']),
    M('Torso Rotation Machine', 'Core', ['obliques', 'abs'], 'machine', 'strength', 3.5, 'beginner', 'isolation', 'pull', [
        'Sit upright with your back against the pad and set the range-of-motion pin so your hips stay facing forward.',
        'Place your arms on the arm pads or grip the handles and keep your feet planted.',
        'Rotate your torso to one side using your abs and obliques, not your arms, until you reach a comfortable end range.',
        'Pause briefly, then rotate slowly back through the middle to the other side.',
        'Keep your hips still and your movement smooth, and do equal reps on both sides.']),
    M('45-Degree Back Extension', 'Back', ['lower back', 'glutes', 'hamstrings'], 'machine', 'bodyweight', 3.5, 'beginner', 'isolation', 'pull', [
        'Adjust the pad so it sits just below your hip crease and your heels are secured under the rollers, with your body at about 45 degrees.',
        'Cross your arms over your chest (or hold a plate against it for extra load) and keep your neck in line with your spine.',
        'Hinge forward at your hips, lowering your torso until you feel a stretch in your hamstrings, keeping your back flat.',
        'Squeeze your glutes and hamstrings to lift your torso back up until your body forms a straight line.',
        'Stop at a straight line and do not hyperextend your lower back at the top.'], src='Hyperextensions (Back Extensions)'),
    M("Captain's Chair Knee Raise", 'Core', ['abs', 'hip flexors'], 'other', 'bodyweight', 4, 'beginner', 'isolation', 'pull', [
        'Step into the captain\'s chair, rest your forearms on the pads with your elbows at 90 degrees, grip the handles, and press your back into the backrest.',
        'Let your legs hang straight down with your shoulders pulled down away from your ears.',
        'Brace your abs and raise your knees toward your chest, curling your pelvis up at the top.',
        'Pause for a second at the top without swinging.',
        'Lower your legs slowly under control until they are hanging straight again.'], src='Knee/Hip Raise On Parallel Bars'),
    M('Smith Machine Lunge', 'Quads', ['quads', 'glutes', 'hamstrings'], 'smith', 'strength', 5, 'intermediate', 'compound', 'push', [
        'Set the bar at upper-back height, step under it, rest it across your upper back, and unrack it by twisting the bar.',
        'Step one foot forward so that your front foot is ahead of the bar line and your rear foot stays back on its toes.',
        'Bend both knees to lower your back knee close to the floor while keeping your torso upright.',
        'Push through your front heel to return to the start.',
        'Complete all reps on one leg before switching, then rack the bar.']),
    M('Meadows Row', 'Back', ['lats', 'upper back', 'rear delts', 'biceps'], 'barbell', 'strength', 5, 'intermediate', 'compound', 'pull', [
        'Anchor one end of a barbell in a landmine sleeve or a corner and load plates on the other end.',
        'Stand side-on to the bar, hinge at your hips, and grip the thick end of the bar near the plates with an overhand grip.',
        'Keep your back flat and chest proud, and pull your elbow up and back toward your hip.',
        'Squeeze your lat at the top for a second.',
        'Lower slowly until your arm is straight, then finish the set and switch sides.']),
    M('Machine Pullover', 'Back', ['lats', 'triceps', 'chest'], 'machine', 'strength', 3.5, 'beginner', 'isolation', 'pull', [
        'Adjust the seat so your shoulders line up with the pivot of the machine and fasten the seat belt if there is one.',
        'Place your elbows on the pads (or grip the handles) above and behind your head with your elbows slightly bent.',
        'Drive your elbows down and forward in an arc until the bar or pads reach your waist.',
        'Squeeze your lats at the bottom without rounding your shoulders.',
        'Return slowly to a full stretch overhead.']),
    M('Cable Y-Raise', 'Shoulders', ['rear delts', 'side delts', 'traps'], 'cable', 'strength', 3.5, 'intermediate', 'isolation', 'pull', [
        'Set a single pulley at the lowest position, attach a handle, and stand facing the stack holding the handle with a thumbs-up grip.',
        'Keep a soft bend in your elbow and your ribs down.',
        'Raise your arm up and out at an angle to make a Y shape until it is just above head height.',
        'Pause briefly at the top without shrugging.',
        'Lower slowly and finish all reps before switching arms.']),
    M('Dumbbell Squeeze Press', 'Chest', ['chest', 'triceps', 'front delts'], 'dumbbell', 'strength', 5, 'beginner', 'compound', 'push', [
        'Lie on a flat bench holding two dumbbells together above your chest with your palms facing each other.',
        'Press the dumbbells firmly into each other and keep squeezing throughout the set.',
        'Lower the dumbbells to your mid-chest while squeezing them, keeping your elbows at about 45 degrees.',
        'Press back up while still squeezing, stopping just short of locking your elbows.']),
    M('Single-Arm Cable Pushdown', 'Triceps', ['triceps'], 'cable', 'strength', 3.5, 'beginner', 'isolation', 'push', [
        'Attach a single handle to a high pulley, stand facing it, and hold the handle with one hand with your elbow tucked at your side and bent to 90 degrees.',
        'Press the handle down until your arm is fully extended and squeeze your triceps.',
        'Return slowly until your forearm is just past parallel to the floor.',
        'Keep your shoulder and elbow still, and finish all reps before switching arms.']),
    M('Spin Bike (Indoor Cycling)', 'Cardio', ['quads', 'hamstrings', 'glutes', 'calves'], 'machine', 'cardio', 8.5, 'beginner', None, None, [
        'Adjust the saddle so your knee has a slight bend at the bottom of the pedal stroke, and set the handlebars at a comfortable reach.',
        'Clip in or strap your feet, hold the handlebars lightly, and keep your core braced.',
        'Warm up at an easy cadence of about 80 rpm and add resistance gradually.',
        'For intervals, add resistance and push hard for 30 to 60 seconds, then recover at low resistance.',
        'Keep your shoulders relaxed and your back flat, and cool down with three to five minutes of easy pedalling.']),
    M('Toes-to-Bar', 'Core', ['abs', 'hip flexors', 'lats'], 'bodyweight', 'bodyweight', 5, 'expert', 'compound', 'pull', [
        'Hang from a pull-up bar with an overhand grip, shoulders active and legs together.',
        'Engage your lats, swing slightly back, then kick forward as you pull your toes up.',
        'Raise your legs until your toes touch the bar, keeping your legs as straight as you can.',
        'Lower your legs under control and avoid wild swinging between reps.']),
    M('Dumbbell Snatch', 'Full Body', ['glutes', 'hamstrings', 'front delts', 'traps', 'quads'], 'dumbbell', 'strength', 6, 'intermediate', 'compound', 'pull', [
        'Stand with your feet shoulder-width apart and a dumbbell on the floor between them, then hinge down and grip it with one hand.',
        'Drive your hips forward explosively and pull the dumbbell up close to your body with your elbow high.',
        'Punch the dumbbell overhead and lock out your arm, catching it with a slight knee bend.',
        'Lower it under control back to the floor, reset, and repeat before switching arms.']),
    M('Dumbbell Clean and Press', 'Full Body', ['front delts', 'glutes', 'quads', 'triceps', 'traps'], 'dumbbell', 'strength', 6, 'intermediate', 'compound', 'push', [
        'Stand with your feet hip-width apart and a pair of dumbbells at your sides or on the floor, and hinge to grip them.',
        'Explosively extend your hips and shrug to pull the dumbbells up, then rotate your elbows under and catch them on your shoulders.',
        'Dip your knees slightly, then drive up and press the dumbbells overhead until your arms are straight.',
        'Lower the dumbbells back to your shoulders, then to your sides, and reset before the next rep.']),
    M('Suitcase Carry', 'Core', ['obliques', 'forearms', 'traps', 'abs'], 'dumbbell', 'timed', 5, 'beginner', 'compound', 'static', [
        'Hold a heavy dumbbell or kettlebell in one hand at your side and stand tall with your shoulders level.',
        'Brace your abs and resist the urge to lean toward the weight.',
        'Walk slowly with controlled steps for the set distance or time.',
        'Switch hands and repeat so both sides get equal work.']),
    M('Tibialis Raise', 'Calves', ['calves'], 'bodyweight', 'bodyweight', 3.5, 'beginner', 'isolation', 'pull', [
        'Stand with your back against a wall and your feet about a foot in front of you, shoulder-width apart.',
        'Keep your legs straight and lift your toes toward your shins as high as you can.',
        'Pause at the top and feel the muscle on the front of your shins working.',
        'Lower your toes slowly to the floor and repeat.']),
    M('Cossack Squat', 'Quads', ['quads', 'glutes', 'adductors', 'hamstrings'], 'bodyweight', 'bodyweight', 4, 'intermediate', 'compound', 'push', [
        'Stand with your feet about twice shoulder-width apart and toes turned out slightly.',
        'Shift your weight onto one leg, bending that knee and sitting your hips back and down while the other leg stays straight with the toes up.',
        'Keep your chest up and the heel of your bent leg flat on the floor.',
        'Push through that foot to return to the centre, then repeat on the other side.']),
]

# Original exercises with no source match: hand-written steps (steps, level, mechanic, force).
# Also used to fill steps for original exercises whose source record has images but no text.
EXISTING_STEPS = {
    'cable_fly_mid': ([
        'Set both pulleys at chest height and attach a single handle to each, then stand in the middle with one foot slightly forward.',
        'Take a handle in each hand and step forward so the cables pull your arms back, with a soft bend in your elbows.',
        'Keeping that elbow angle fixed, bring your hands together in a wide arc in front of your chest.',
        'Squeeze your chest for a second when your hands meet.',
        'Open your arms back slowly until you feel a stretch across your chest, without letting your shoulders roll forward.'],
        'beginner', 'isolation', 'push'),
    'knee_push_up': ([
        'Start on your hands and knees with your hands slightly wider than your shoulders and your body in a straight line from head to knees.',
        'Brace your abs and squeeze your glutes so your hips do not sag.',
        'Bend your elbows to lower your chest toward the floor, keeping them at about 45 degrees to your body.',
        'Press the floor away until your arms are straight again.'],
        'beginner', 'compound', 'push'),
    'pendlay_row': ([
        'Stand with your feet hip-width apart and the barbell over your mid-foot, then hinge until your torso is almost parallel to the floor.',
        'Grip the bar just outside your knees with a flat back and the bar resting on the floor.',
        'Explosively row the bar to your lower chest, keeping your torso still.',
        'Lower the bar back to the floor under control and reset fully before each rep.'],
        'intermediate', 'compound', 'pull'),
    'machine_seated_row': ([
        'Adjust the seat and chest pad so your arms can reach the handles when fully extended, and sit tall with your chest on the pad.',
        'Grip the handles and set your shoulder blades back and down.',
        'Pull the handles toward your torso by driving your elbows back, squeezing your shoulder blades together.',
        'Pause for a second, then return the handles slowly until you feel a stretch in your back.'],
        'beginner', 'compound', 'pull'),
    'assisted_pull_up': ([
        'Choose the assistance weight (a heavier pin makes it easier) and kneel or stand on the pad.',
        'Grip the bars slightly wider than your shoulders with your palms facing away.',
        'Pull your chest toward the bar by driving your elbows down and back until your chin clears the bar.',
        'Lower yourself slowly until your arms are fully straight, then repeat.'],
        'beginner', 'compound', 'pull'),
    'landmine_press': ([
        'Anchor one end of a barbell in a landmine sleeve and hold the other end at your shoulder with one or both hands.',
        'Stand with feet hip-width apart, ribs down, and a slight bend in your knees.',
        'Press the end of the bar up and forward until your arm is fully extended.',
        'Lower the bar back to your shoulder with control.'],
        'beginner', 'compound', 'push'),
    'pike_push_up': ([
        'Start in a push-up position, then walk your feet in and lift your hips so your body forms an upside-down V.',
        'Place your hands slightly wider than your shoulders.',
        'Bend your elbows to lower the top of your head toward the floor between your hands.',
        'Press back up to the start without letting your hips drop.'],
        'intermediate', 'compound', 'push'),
    'bayesian_cable_curl': ([
        'Set a single pulley at the lowest position, attach a handle, and stand facing away from the stack with the handle in one hand, so the cable passes behind you.',
        'Take a step forward so your arm is pulled slightly behind your body and your biceps is stretched.',
        'Curl the handle up toward your shoulder, keeping your upper arm back and your elbow still.',
        'Squeeze at the top, then lower slowly back into the stretch and finish all reps before switching arms.'],
        'intermediate', 'isolation', 'pull'),
    'dead_hang': ([
        'Reach up and grip a pull-up bar with an overhand grip, hands about shoulder-width apart.',
        'Step off or lift your feet so your arms are straight and your body hangs freely.',
        'Keep your shoulders gently pulled down and your core lightly braced.',
        'Hold for the target time, then lower yourself down to the floor.'],
        'beginner', 'isolation', 'static'),
    'bulgarian_split_squat': ([
        'Stand about two feet in front of a bench and place the top of one rear foot on it, holding a dumbbell in each hand.',
        'Keep your torso upright and your front foot flat on the floor.',
        'Bend your front knee to lower your hips straight down until your front thigh is about parallel to the floor.',
        'Drive through your front heel to stand, then finish all reps before switching legs.'],
        'intermediate', 'compound', 'push'),
    'walking_lunge': ([
        'Stand tall holding a dumbbell in each hand at your sides.',
        'Take a long step forward and lower your back knee toward the floor, keeping your torso upright.',
        'Push through your front heel and bring your back foot forward into the next step.',
        'Continue alternating legs as you walk forward, keeping your front knee in line with your toes.'],
        'beginner', 'compound', 'push'),
    'pistol_squat': ([
        'Stand on one leg with the other leg extended out in front of you and your arms reaching forward for balance.',
        'Sit your hips back and bend your standing knee to lower yourself as deep as you can control.',
        'Keep your standing heel flat and your chest tall.',
        'Drive through your heel to stand back up, and use a box or a support to assist if you need to.'],
        'expert', 'compound', 'push'),
    'wall_sit': ([
        'Stand with your back against a wall and walk your feet forward about two feet.',
        'Slide down until your knees are bent to 90 degrees and your thighs are parallel to the floor.',
        'Keep your back flat against the wall and your knees over your ankles.',
        'Hold for the target time, then slide back up.'],
        'beginner', 'isolation', 'static'),
    'lateral_lunge': ([
        'Stand tall with your feet together and your hands in front of your chest.',
        'Step out wide to one side and sit your hips back, bending that knee while the other leg stays straight.',
        'Keep your chest up and the foot of your bent leg flat on the floor.',
        'Push through that foot to return to standing, then repeat on the other side.'],
        'beginner', 'compound', 'push'),
    'single_leg_rdl': ([
        'Stand on one leg holding a dumbbell in the opposite hand, with a soft bend in your standing knee.',
        'Hinge at your hip and reach the dumbbell toward the floor while your free leg extends straight behind you.',
        'Keep your back flat and your hips square to the floor.',
        'Squeeze your glute to return to standing, and finish all reps before switching legs.'],
        'intermediate', 'compound', 'pull'),
    'curtsy_lunge': ([
        'Stand tall holding a dumbbell at your chest or a pair at your sides.',
        'Step one foot back and across behind your standing leg, as if curtsying.',
        'Lower your back knee toward the floor while keeping your torso upright and your front knee over your toes.',
        'Push through your front foot to return to the start, then repeat on the other side.'],
        'intermediate', 'compound', 'push'),
    'bodyweight_calf_raise': ([
        'Stand with your feet hip-width apart on the floor or on the edge of a step.',
        'Rise onto the balls of your feet as high as you can.',
        'Pause for a second at the top and squeeze your calves.',
        'Lower your heels slowly until you feel a stretch, then repeat.'],
        'beginner', 'isolation', 'push'),
    'single_leg_calf_raise': ([
        'Stand on one foot on the edge of a step with your heel hanging off, holding a wall or rail for balance.',
        'Rise up onto the ball of your foot as high as you can.',
        'Pause at the top, then lower your heel slowly below the step to feel a full stretch.',
        'Finish all reps on one leg before switching.'],
        'intermediate', 'isolation', 'push'),
    'hanging_knee_raise': ([
        'Hang from a pull-up bar with an overhand grip, shoulders pulled down and legs together.',
        'Brace your abs and raise your knees toward your chest, curling your pelvis up slightly at the top.',
        'Pause for a second without swinging.',
        'Lower your legs slowly until they hang straight again.'],
        'intermediate', 'isolation', 'pull'),
    'bird_dog': ([
        'Start on your hands and knees with your hands under your shoulders and your knees under your hips.',
        'Brace your abs and keep your back flat.',
        'Reach your right arm forward and your left leg back until both are in line with your torso.',
        'Pause, then return slowly and repeat on the other side without letting your hips rotate.'],
        'beginner', 'isolation', 'static'),
    'hollow_hold': ([
        'Lie on your back with your arms extended overhead and your legs straight.',
        'Press your lower back into the floor and lift your shoulders and legs a few inches off the ground.',
        'Keep your ribs down and your lower back pressed flat the whole time.',
        'Hold for the target time, then lower with control.'],
        'intermediate', 'isolation', 'static'),
    'l_sit': ([
        'Sit between two parallel bars or on two sturdy blocks and place your hands beside your hips.',
        'Press down to lift your body off the floor with your arms straight.',
        'Raise your legs straight out in front of you until they are parallel to the floor.',
        'Hold with your shoulders pushed down and your core tight, then lower with control.'],
        'expert', 'isolation', 'static'),
    'decline_sit_up': ([
        'Lock your feet under the pads of a decline bench and lie back with your hands across your chest or behind your head.',
        'Brace your abs and curl your torso up toward your knees.',
        'Pause at the top without pulling on your neck.',
        'Lower back down slowly until your shoulder blades touch the bench.'],
        'intermediate', 'isolation', 'pull'),
    'plank_shoulder_taps': ([
        'Start in a high plank position with your hands under your shoulders and your feet slightly wider than hip-width.',
        'Brace your abs and squeeze your glutes to keep your body in a straight line.',
        'Lift one hand and tap the opposite shoulder, keeping your hips from rocking.',
        'Return the hand to the floor and alternate sides at a steady pace.'],
        'intermediate', 'compound', 'static'),
    'burpees': ([
        'Stand with your feet shoulder-width apart, then squat down and place your hands on the floor.',
        'Jump or step your feet back into a plank and lower your chest to the floor.',
        'Push up, then jump your feet back toward your hands.',
        'Explode up into a jump with your arms overhead, and land softly to start the next rep.'],
        'intermediate', 'compound', 'push'),
    'kettlebell_swing': ([
        'Stand with your feet slightly wider than your shoulders and a kettlebell on the floor a foot in front of you.',
        'Hinge at your hips with a flat back, grip the handle with both hands, and hike the bell back between your legs.',
        'Drive your hips forward explosively so the bell swings up to chest height, with your arms acting as ropes.',
        'Let the bell fall back and hinge again so it swings between your legs, keeping your back flat throughout.'],
        'intermediate', 'compound', 'pull'),
    'dumbbell_thruster': ([
        'Hold a dumbbell in each hand at your shoulders with your feet shoulder-width apart.',
        'Squat down until your thighs are parallel to the floor, keeping your chest up.',
        'Drive up through your heels and use that momentum to press the dumbbells overhead.',
        'Lower the dumbbells back to your shoulders as you sink into the next squat.'],
        'intermediate', 'compound', 'push'),
    'bear_crawl': ([
        'Start on your hands and knees, then lift your knees an inch or two off the floor.',
        'Keep your back flat and your hips low.',
        'Crawl forward by moving your opposite hand and foot together.',
        'Keep your steps small and controlled for the set distance or time.'],
        'intermediate', 'compound', 'static'),
    'assault_bike': ([
        'Adjust the seat so your knee has a slight bend at the bottom of the pedal stroke and grip the moving handles.',
        'Push and pull the handles while pedalling so your arms and legs work together.',
        'For intervals, go all out for 10 to 30 seconds, then ease off for the rest period.',
        'Keep your core braced and your breathing steady, and cool down with easy pedalling.'],
        'intermediate', None, None),
    'incline_treadmill_walk': ([
        'Step onto the treadmill and set an incline of about 8 to 12 percent with a speed of 4 to 5.5 km/h.',
        'Walk with your chest up and a slight forward lean from your ankles, not your waist.',
        'Let your arms swing naturally and avoid holding on to the handrails.',
        'Keep your steps full and your glutes engaged, and reduce the incline slowly to cool down.'],
        'beginner', None, None),
    'jumping_jacks': ([
        'Stand with your feet together and your arms by your sides.',
        'Jump your feet out to the sides while swinging your arms overhead.',
        'Jump back to the start position and repeat at a steady rhythm.',
        'Land softly on the balls of your feet.'],
        'beginner', None, None),
    'pigeon_pose': ([
        'Start on your hands and knees, then slide one knee forward behind your wrist with your shin angled across the mat.',
        'Extend your other leg straight back with the top of your foot on the floor.',
        'Square your hips to the floor and lower your chest over your front shin.',
        'Hold for the target time while breathing slowly, then switch sides.'],
        'intermediate', None, 'static'),
    'thoracic_rotation': ([
        'Lie on your side with your knees bent to 90 degrees and your arms straight out in front of you, palms together.',
        'Keep your knees stacked and lift your top arm up and over, opening your chest toward the ceiling.',
        'Follow your hand with your eyes and rotate through your upper back.',
        'Return slowly to the start and repeat, then switch sides.'],
        'beginner', None, 'static'),
    'shoulder_dislocates': ([
        'Hold a resistance band or a light stick with a wide overhand grip in front of your thighs.',
        'Keeping your arms straight, lift the band overhead and behind you as far as is comfortable.',
        'Return slowly to the front, narrowing your grip if you feel any pinching.',
        'Keep your ribs down and your core braced throughout.'],
        'beginner', None, 'static'),
}

EXISTING_STEPS.update({
    'brisk_walk': ([
        'Stand tall, look ahead, and start walking at a pace where you breathe harder but can still talk.',
        'Take quick, medium-length steps, landing on your heel and rolling through to your toes.',
        'Bend your elbows to about 90 degrees and swing your arms naturally.',
        'Keep your core lightly braced and walk for the planned time, finishing with a slower cool-down.'],
        'beginner', None, None),
    'run_easy': ([
        'Warm up with a few minutes of brisk walking or very light jogging.',
        'Run at a pace where you can hold a conversation, with short quick steps and a tall posture.',
        'Land with your foot under your hips, relax your shoulders, and let your arms swing naturally.',
        'Finish with a few minutes of walking to cool down.'],
        'beginner', None, None),
    'run_tempo': ([
        'Warm up for 5 to 10 minutes with easy running.',
        'Increase to a comfortably hard pace that you could hold for about 20 to 30 minutes, where you can only speak in short phrases.',
        'Keep your cadence quick, your posture tall, and your breathing controlled.',
        'Cool down with 5 to 10 minutes of easy jogging or walking.'],
        'intermediate', None, None),
    'sprint_intervals': ([
        'Warm up thoroughly with 5 to 10 minutes of easy jogging and a few short strides.',
        'Sprint hard for 10 to 30 seconds, driving your knees and arms with a slight forward lean.',
        'Walk or jog slowly for 60 to 90 seconds to recover fully before the next sprint.',
        'Repeat for the planned number of rounds and cool down with easy walking.'],
        'intermediate', None, None),
    'surya_namaskar': ([
        'Stand with your feet together and palms joined at your chest, then inhale and raise your arms overhead.',
        'Exhale and fold forward to touch the floor, then inhale and step one leg back into a low lunge.',
        'Step the other leg back into a plank, lower your body to the floor, and press up into cobra pose.',
        'Exhale into downward-facing dog, then step forward, rise, and return to standing to finish one round.'],
        'beginner', None, 'static'),
    'foam_rolling': ([
        'Place the foam roller under the muscle you want to release, such as your quads, hamstrings, upper back, or calves.',
        'Support your weight with your hands and roll slowly back and forth over the muscle.',
        'When you find a tender spot, pause on it for 20 to 30 seconds while breathing slowly.',
        'Avoid rolling directly over joints or your lower back, and spend about 1 to 2 minutes per muscle.'],
        'beginner', None, 'static'),
})

# Coaching cues (3) and common mistakes (2) for the most common NEW gym exercises.
def C(c1, c2, c3, m1, m2):
    return ([c1, c2, c3], [m1, m2])

CUES = {
    # --- chest
    'incline_machine_chest_press': C('Set the seat so the handles line up with your upper chest', 'Keep your shoulder blades pinned back into the pad', 'Press up and slightly in, stopping short of lockout',
                                     'Letting the shoulders roll forward off the pad', 'Using a seat height that turns it into a shoulder press'),
    'decline_machine_chest_press': C('Keep your chest up and shoulder blades squeezed', 'Press the handles down and forward in one smooth line', 'Lower slowly until you feel a chest stretch',
                                     'Bouncing the weight at the bottom', 'Shrugging the shoulders up toward the ears'),
    'plate_loaded_chest_press_hammer_strength': C('Adjust the seat so handles sit at mid-chest height', 'Drive the handles forward without letting your back leave the pad', 'Control the weight on the way back',
                                                  'Loading too heavy and cutting the range of motion', 'Flaring the elbows straight out to the sides'),
    'cable_chest_press_seated': C('Set the handles at chest height and sit tall', 'Press straight forward and squeeze your chest', 'Let the handles return slowly until you feel a stretch',
                                  'Leaning forward to throw the weight', 'Letting the elbows drop below the handles'),
    'cable_chest_press_standing': C('Take a staggered stance and brace your core', 'Press the handles forward at chest height', 'Control the return without leaning back',
                                    'Leaning your whole body into each rep', 'Pressing too low or too high instead of at chest level'),
    'incline_cable_chest_press': C('Set the bench at about 30 degrees', 'Press up and in toward the top of your chest', 'Keep your shoulder blades back and down',
                                   'Using a bench angle that is too steep', 'Letting the cables pull your shoulders forward'),
    'incline_cable_fly': C('Keep a soft bend in your elbows', 'Bring your hands together in a wide arc over your upper chest', 'Squeeze at the top and stretch slowly on the way back',
                           'Turning the fly into a press by bending the arms too much', 'Going so heavy that the shoulders take over'),
    'flat_bench_cable_fly': C('Lie back with a handle in each hand and arms slightly bent', 'Sweep your hands together over your chest', 'Lower slowly until you feel a stretch',
                              'Bending and straightening the elbows during the rep', 'Letting the weight pull your shoulders off the bench'),
    'single_arm_cable_crossover': C('Stand tall with a staggered stance', 'Pull the handle across your body in a smooth arc', 'Squeeze your chest at the end of the rep',
                                    'Rotating your torso to cheat the weight', 'Using momentum instead of your chest'),
    'smith_machine_incline_bench_press': C('Set the bench at about 30 degrees under the bar', 'Lower the bar to your upper chest with elbows at about 45 degrees', 'Press up and rotate the bar back onto the hooks when done',
                                           'Placing the bench too far forward or back so the bar path is awkward', 'Locking out your elbows hard at the top'),
    'decline_dumbbell_bench_press': C('Secure your legs and keep your feet planted', 'Lower the dumbbells to your lower chest', 'Press up in a slight arc until the dumbbells meet over your chest',
                                      'Skipping a spotter or a safe way to get the dumbbells into position', 'Letting the dumbbells drift toward your face'),
    'neutral_grip_dumbbell_bench_press': C('Keep your palms facing each other', 'Tuck your elbows to about 45 degrees', 'Press up until your arms are straight without clanging the dumbbells',
                                           'Flaring the elbows out wide', 'Dropping the dumbbells too fast at the bottom'),
    'dumbbell_floor_press': C('Lie on the floor with your knees bent', 'Lower until your upper arms touch the floor', 'Press up powerfully without bouncing',
                              'Resting the full weight of your arms on the floor between reps', 'Arching your lower back off the floor'),
    'wide_grip_barbell_bench_press': C('Grip the bar wider than shoulder width', 'Lower the bar to your mid-chest', 'Keep your shoulder blades pulled back and down',
                                       'Going so wide that shoulders get irritated', 'Bouncing the bar off your chest'),
    'smith_machine_close_grip_bench_press': C('Place your hands just inside shoulder width', 'Keep your elbows close to your ribs', 'Lower the bar to your lower chest and press up',
                                              'Gripping so narrow that your wrists hurt', 'Flaring your elbows out'),
    # --- back
    'machine_shrug': C('Stand tall with your arms straight', 'Lift your shoulders straight up toward your ears', 'Hold the top for a second and lower slowly',
                       'Rolling the shoulders instead of lifting straight up', 'Using so much weight that the range is tiny'),
    'smith_machine_shrug': C('Hold the bar just outside your thighs', 'Shrug straight up and pause at the top', 'Lower until you feel a full stretch in your traps',
                             'Bending your elbows to help lift the bar', 'Pushing your head forward as you shrug'),
    'cable_shrug': C('Keep your arms straight with the handles at your sides', 'Shrug up and squeeze your traps', 'Lower slowly for a full stretch',
                     'Bending the elbows', 'Rocking your torso to lift the weight'),
    'plate_loaded_iso_row_hammer_strength': C('Set the chest pad so your arms reach the handles fully extended', 'Pull the handles back by driving your elbows behind you', 'Squeeze your shoulder blades together at the end',
                                              'Using your lower back to heave the weight', 'Cutting the stretch short at the start of each rep'),
    'high_row_machine_plate_loaded': C('Sit tall with your chest up and knees secured', 'Pull the handles down and back toward your torso', 'Pause and control the return',
                                       'Leaning back to finish the rep', 'Shrugging your shoulders during the pull'),
    'chest_supported_t_bar_row': C('Keep your chest firmly on the pad', 'Pull the handles toward your lower ribs', 'Squeeze your shoulder blades together at the top',
                                   'Lifting your chest off the pad to cheat', 'Shrugging toward your ears'),
    'lat_pulldown_v_bar': C('Sit with your thighs locked under the pads', 'Pull the handle to your upper chest and lean back slightly', 'Drive your elbows down toward your hips',
                            'Swinging your torso to move the weight', 'Letting the bar pull your shoulders up at the top'),
    'seated_cable_row_wide_grip': C('Sit tall with a flat back', 'Pull the bar to your lower chest, elbows flared slightly', 'Squeeze your shoulder blades together',
                                    'Rocking back and forth with your torso', 'Rounding your back at the stretch'),
    'seated_cable_row_v_bar': C('Keep your chest up and back flat', 'Pull the handle to your belly button with elbows close', 'Pause and squeeze your shoulder blades',
                                'Leaning way back to finish each rep', 'Letting your shoulders round forward at the start'),
    'straight_arm_pulldown_rope': C('Hinge slightly forward with arms almost straight', 'Sweep the rope down to your thighs using your lats', 'Squeeze your lats and return slowly',
                                    'Bending the elbows to turn it into a pushdown', 'Using your body weight to drag the rope down'),
    'bent_over_dumbbell_row': C('Hinge until your torso is close to parallel to the floor', 'Row both dumbbells toward your hips', 'Keep your back flat and neck neutral',
                                'Rounding your lower back', 'Jerking the weights with momentum'),
    'reverse_grip_barbell_row': C('Hold the bar with an underhand grip', 'Pull the bar toward your lower stomach', 'Keep your elbows close to your body',
                                  'Standing too upright so it becomes a shrug', 'Letting the bar drift away from your thighs'),
    'smith_machine_bent_over_row': C('Hinge forward with a flat back', 'Row the bar toward your lower ribs', 'Control the bar back down',
                                     'Standing too far from the bar so you round forward', 'Using momentum from the hips'),
    'meadows_row': C('Hinge at the hips with a flat back', 'Pull your elbow up and back toward your hip', 'Squeeze your lat at the top of the rep',
                     'Twisting your torso to lift the weight', 'Cutting the range short at the bottom'),
    'machine_pullover': C('Align your shoulders with the pivot point', 'Drive your elbows down and forward in an arc', 'Squeeze your lats at the bottom',
                          'Using your arms instead of your lats', 'Letting the weight yank your shoulders at the top'),
    '45_degree_back_extension': C('Set the pad just below your hip crease', 'Hinge at the hips and keep your spine long', 'Squeeze your glutes as you lift to a straight line',
                                  'Over-arching your lower back at the top', 'Swinging up with momentum'),
    'reverse_hyperextension': C('Lie face down with your hips at the edge of the pad', 'Lift your legs until they are in line with your torso', 'Control the swing back down',
                                'Swinging the legs with momentum', 'Over-arching your lower back at the top'),
    # --- shoulders
    'machine_lateral_raise': C('Line your shoulders up with the pivot', 'Lead with your elbows as you raise the pads', 'Stop when your upper arms are roughly parallel to the floor',
                               'Shrugging your traps up', 'Using body momentum to swing the weight'),
    'cable_shoulder_press': C('Sit or stand tall with your core braced', 'Press the handles overhead in a smooth line', 'Lower to shoulder height under control',
                              'Leaning back so it becomes an incline press', 'Flaring your ribs out'),
    'standing_dumbbell_shoulder_press': C('Stand tall with your abs braced', 'Press the dumbbells straight overhead', 'Lower to your shoulders with control',
                                          'Arching your lower back as you press', 'Using your legs to push press every rep'),
    'one_arm_dumbbell_shoulder_press': C('Brace your core and keep your ribs down', 'Press straight overhead beside your ear', 'Lower with control to shoulder height',
                                         'Leaning sideways to finish the rep', 'Letting your wrist bend backward'),
    'cable_front_raise': C('Stand facing away from the cable with the handle between your legs', 'Raise your arm to shoulder height with a slight elbow bend', 'Lower slowly without losing tension',
                           'Swinging your torso to lift', 'Raising the arm above shoulder height'),
    'seated_rear_delt_raise': C('Sit and hinge forward with a flat back', 'Raise the dumbbells out to the sides with soft elbows', 'Squeeze your rear delts at the top',
                                'Using momentum from your torso', 'Going heavy and shrugging your traps'),
    'cable_y_raise': C('Keep your ribs down and shoulders away from your ears', 'Raise your arm up and out into a Y shape', 'Lower slowly and keep tension on the cable',
                       'Shrugging at the top', 'Swinging your body to lift the weight'),
    'cable_upright_row': C('Hold the bar or rope close to your body', 'Lead with your elbows up to about chest height', 'Lower slowly under control',
                           'Pulling the handle above chest height', 'Using momentum from your hips'),
    # --- biceps
    'machine_preacher_curl': C('Set the seat so your armpits touch the top of the pad', 'Curl the handles up and squeeze your biceps', 'Lower slowly until your arms are almost straight',
                               'Lifting your elbows off the pad', 'Dropping the weight quickly at the bottom'),
    'machine_biceps_curl': C('Adjust the seat so your elbows line up with the pivot', 'Curl up and squeeze at the top', 'Control the lowering phase',
                             'Swinging your body to lift the weight', 'Letting your shoulders roll forward'),
    'cable_hammer_curl_rope': C('Hold the rope with your palms facing each other', 'Keep your elbows tight to your sides', 'Pull the rope ends apart slightly at the top',
                                'Swinging your torso back', 'Letting your elbows drift forward'),
    'cable_preacher_curl': C('Set the pad so your arms rest fully on it', 'Curl up smoothly and squeeze', 'Lower until your arms are nearly straight',
                             'Lifting your elbows off the pad', 'Using your shoulders to lift'),
    'seated_dumbbell_curl': C('Sit tall with your back against the bench', 'Curl the dumbbells up while keeping your elbows still', 'Lower slowly for a full stretch',
                              'Swinging the weights with your body', 'Moving your elbows forward'),
    'incline_hammer_curl': C('Lie back on an incline bench with arms hanging straight down', 'Curl up with your palms facing each other', 'Lower slowly into a deep stretch',
                             'Letting your elbows swing forward', 'Using a bench so upright that the stretch is lost'),
    'cross_body_hammer_curl': C('Keep your upper arm still', 'Curl the dumbbell across your body toward the opposite shoulder', 'Lower with control',
                                'Swinging your torso', 'Letting your elbow drift away from your side'),
    'zottman_curl': C('Curl up with your palms facing up', 'Rotate your palms to face down at the top', 'Lower slowly with an overhand grip',
                      'Going too heavy and swinging', 'Rushing the lowering phase'),
    'lying_cable_curl': C('Lie back with your feet near the pulley', 'Curl the bar up toward your forehead', 'Lower slowly to a full stretch',
                          'Lifting your elbows off the floor', 'Using momentum from your back'),
    'one_arm_cable_curl': C('Stand tall with your elbow tight to your side', 'Curl the handle up and squeeze', 'Lower slowly to full extension',
                            'Leaning to the side to lift', 'Letting your elbow swing forward'),
    # --- triceps
    'tricep_pushdown_v_bar': C('Keep your elbows pinned to your sides', 'Press the handle down until your arms are straight', 'Let your hands come back up to chest height slowly',
                               'Leaning over the bar to push the weight', 'Letting your elbows flare away from your body'),
    'tricep_pushdown_reverse_grip': C('Hold the bar with an underhand grip', 'Keep your elbows tucked to your sides', 'Push down until your arms are straight',
                                      'Letting your wrists bend back', 'Using your body weight to push the bar down'),
    'seated_dip_machine': C('Adjust the seat so the handles are near your lower chest', 'Press down until your arms are straight', 'Return slowly with elbows close to your sides',
                            'Shrugging your shoulders during the press', 'Locking out the elbows hard'),
    'assisted_dip_machine': C('Choose enough assistance to complete full reps', 'Lower until your upper arms are parallel to the floor', 'Press up without locking your elbows',
                              'Letting your shoulders roll forward at the bottom', 'Going too deep and straining your shoulders'),
    'machine_triceps_extension': C('Set the seat so your elbows line up with the pivot', 'Extend your arms fully and squeeze', 'Return slowly',
                                   'Letting your shoulders rise', 'Using body momentum'),
    'lying_dumbbell_triceps_extension': C('Keep your upper arms vertical', 'Lower the dumbbells toward your forehead or just beside it', 'Extend until your arms are straight',
                                          'Flaring your elbows', 'Letting the weights drift too far back'),
    'incline_cable_triceps_extension': C('Lie back on an incline bench facing away from the cable', 'Keep your upper arms still', 'Extend your arms until they are straight',
                                         'Letting your elbows flare wide', 'Moving your upper arms to lift'),
    'one_arm_cable_triceps_extension': C('Stand tall and keep your elbow close to your head', 'Extend your arm fully and squeeze', 'Lower slowly behind your head',
                                         'Letting the elbow drift forward', 'Leaning to one side'),
    'single_arm_cable_pushdown': C('Pin your elbow to your side', 'Press down until your arm is straight', 'Return slowly without lifting your elbow',
                                   'Rotating your torso to push', 'Letting your shoulder roll forward'),
    # --- legs and glutes
    'leg_press_45_degree': C('Place your feet shoulder-width apart in the middle of the platform', 'Lower until your knees reach about 90 degrees', 'Drive through your whole foot and stop before lockout',
                             'Letting your hips lift off the seat at the bottom', 'Locking your knees hard at the top'),
    'horizontal_leg_press_seated': C('Keep your back flat against the pad', 'Lower the platform until your knees hit about 90 degrees', 'Push through your heels and mid-foot',
                                     'Letting your knees cave inward', 'Slamming into lockout'),
    'pendulum_squat': C('Keep your shoulders under the pads and chest up', 'Sit down and back along the arc', 'Drive through your whole foot to stand',
                        'Letting your heels lift off the platform', 'Cutting the depth short'),
    'dumbbell_lunge': C('Hold the dumbbells at your sides with a tall chest', 'Step forward and lower your back knee toward the floor', 'Push through your front heel to return',
                        'Letting your front knee cave inward', 'Leaning your torso too far forward'),
    'dumbbell_squat': C('Hold the dumbbells at your sides or at your shoulders', 'Sit down and back until your thighs are parallel', 'Drive up through your heels',
                        'Letting your knees cave in', 'Rounding your lower back at the bottom'),
    'dumbbell_split_squat': C('Take a long stance with your torso upright', 'Lower your back knee straight down', 'Push through your front heel to rise',
                              'Taking too short a stance so your knee goes far past your toes', 'Letting your front heel lift'),
    'smith_machine_lunge': C('Start with your front foot ahead of the bar line', 'Lower your back knee to just above the floor', 'Push through your front heel to stand',
                             'Placing your front foot too close to the bar line', 'Leaning forward and rounding your back'),
    'glute_kickback_machine': C('Keep your hips square against the pad', 'Push back and slightly up through your heel', 'Squeeze your glute at the top',
                                'Arching your lower back to get more range', 'Swinging the leg with momentum'),
    'hip_thrust_machine': C('Plant your feet shoulder-width apart', 'Drive up through your heels until your hips are fully extended', 'Squeeze your glutes at the top',
                            'Overextending your lower back at the top', 'Pushing through your toes instead of your heels'),
    'smith_machine_hip_thrust': C('Pad the bar and roll it into your hip crease', 'Keep your shins vertical at the top', 'Squeeze hard at the top and lower under control',
                                  'Letting your lower back arch at the top', 'Placing your feet too far or too close'),
    'cable_hip_abduction': C('Hold the frame and stand tall', 'Lift your leg out to the side leading with your heel', 'Lower slowly without losing tension',
                             'Leaning your torso to lift higher', 'Swinging the leg with momentum'),
    'dumbbell_hip_thrust': C('Rest your upper back against a bench', 'Drive through your heels to lift your hips', 'Squeeze your glutes at the top',
                             'Overarching your lower back', 'Letting your feet slide forward'),
    'standing_leg_curl_machine': C('Line your knee up with the pivot', 'Curl your heel toward your glute', 'Lower slowly without letting the weight slam',
                                   'Leaning your torso forward to cheat', 'Using a very short range of motion'),
    'smith_machine_calf_raise': C('Place the balls of your feet on a raised step under the bar', 'Rise as high as you can and pause', 'Lower into a full stretch',
                                  'Bouncing at the bottom', 'Bending your knees to help lift'),
    'donkey_calf_raise': C('Hinge forward and brace on a support', 'Lower your heels for a deep stretch', 'Rise high and squeeze your calves',
                           'Bouncing out of the bottom', 'Bending your knees'),
    'calf_press_machine': C('Place the balls of your feet on the platform', 'Press down to lift the weight and pause', 'Let your heels come back up slowly for a deep stretch',
                            'Bouncing at the bottom', 'Locking your knees hard'),
    # --- core
    'torso_rotation_machine': C('Keep your hips still and facing forward', 'Rotate through your abs and obliques', 'Control the weight back through the middle',
                                'Using your arms to turn the weight', 'Rotating through your lower back'),
    'captains_chair_knee_raise': C('Press your back firmly into the backrest', 'Raise your knees toward your chest', 'Lower slowly without swinging',
                                   'Using momentum to swing your legs up', 'Letting your lower back arch away from the pad'),
    'captains_chair_leg_raise': C('Keep your back pressed into the pad', 'Lift your legs until they are parallel to the floor', 'Lower slowly under control',
                                  'Swinging your legs', 'Bending your knees so much it becomes a knee raise'),
    'seated_cable_crunch': C('Sit tall and hold the rope by your head', 'Curl your ribs toward your pelvis', 'Return slowly',
                             'Pulling with your arms', 'Leaning back to take tension off the abs'),
    'cable_side_bend': C('Stand tall with the handle at your side', 'Bend sideways at your waist', 'Return slowly to upright',
                         'Leaning forward or back', 'Using too much weight and swinging'),
    'sit_up': C('Cross your arms over your chest', 'Curl your torso up toward your knees', 'Lower slowly',
                'Pulling on your neck', 'Using momentum from the floor'),
    # --- cardio
    'treadmill_run': C('Land softly with your foot under your hips', 'Keep a tall posture with a slight forward lean', 'Relax your shoulders and swing your arms',
                       'Overstriding with your heels', 'Gripping the handrails while running'),
    'treadmill_jog': C('Start with a 5 minute easy warm-up', 'Keep your steps light and quiet', 'Breathe steadily in a rhythm',
                       'Holding on to the handrails', 'Starting too fast and burning out'),
    'recumbent_bike': C('Adjust the seat so your knee has a slight bend at full extension', 'Keep your back against the seat', 'Pedal at a steady cadence',
                        'Setting the seat too close so your knees get cramped', 'Pushing with your toes instead of your whole foot'),
    'spin_bike_indoor_cycling': C('Set the saddle to hip height', 'Keep your core braced and shoulders relaxed', 'Control the resistance, not just the speed',
                                  'Bouncing on the saddle with too little resistance', 'Gripping the handlebars too tightly'),
    'stair_mill_step_mill': C('Stand tall without leaning on the rails', 'Place your whole foot on each step', 'Keep a steady rhythm',
                              'Leaning heavily on the handrails', 'Taking steps that are too short or too fast to control'),
    # --- extra barbell / forearm
    'barbell_wrist_curl': C('Rest your forearms on a bench with your palms up', 'Let the bar roll to your fingertips, then curl it up', 'Move only at the wrists',
                            'Lifting your forearms off the bench', 'Going so heavy that the range is tiny'),
}

# Extra search keywords (machine slang first), merged ahead of the auto-generated ones.
KW_EXTRA = {
    'incline_machine_chest_press': ['incline chest press', 'upper chest', 'chest press machine'],
    'decline_machine_chest_press': ['decline chest press', 'lower chest', 'chest press machine'],
    'plate_loaded_chest_press_hammer_strength': ['hammer strength', 'hammer chest press', 'plate loaded chest press', 'chest press'],
    'cable_chest_press_seated': ['cable press', 'chest press', 'seated cable press'],
    'incline_cable_fly': ['incline cable crossover', 'upper chest', 'cable fly'],
    'smith_machine_incline_bench_press': ['smith incline press', 'incline bench', 'upper chest'],
    'smith_machine_decline_bench_press': ['smith decline press', 'decline bench', 'lower chest'],
    'machine_lateral_raise': ['lateral raise machine', 'side delts', 'shoulder machine'],
    'plate_loaded_shoulder_press_hammer_strength': ['hammer shoulder press', 'hammer strength', 'shoulder press'],
    'cable_shoulder_press': ['cable overhead press', 'shoulder press'],
    'machine_shrug': ['shrug machine', 'traps', 'shoulder shrug'],
    'smith_machine_shrug': ['smith shrug', 'traps', 'shrugs'],
    'smith_machine_shrug_behind_the_back': ['smith shrug', 'traps', 'shrugs'],
    'lat_pulldown_v_bar': ['v bar pulldown', 'close grip pulldown', 'lats', 'pulldown'],
    'seated_cable_row_wide_grip': ['wide row', 'seated row', 'cable row', 'back'],
    'seated_cable_row_v_bar': ['v bar row', 'close grip row', 'cable row', 'seated row'],
    'plate_loaded_iso_row_hammer_strength': ['hammer row', 'hammer strength row', 'plate loaded row', 'machine row'],
    'high_row_machine_plate_loaded': ['high row', 'hammer high row', 'plate loaded row'],
    'chest_supported_t_bar_row': ['t bar row', 'tbar', 'chest supported row'],
    'machine_pullover': ['lat pullover machine', 'pullover', 'lats'],
    '45_degree_back_extension': ['hyperextension', 'back extension', 'roman chair', 'lower back'],
    'assisted_dip_machine': ['assisted dips', 'dip machine', 'dips'],
    'seated_dip_machine': ['dip machine', 'seated dips', 'tricep dips', 'triceps machine'],
    'machine_preacher_curl': ['preacher curl machine', 'preacher machine', 'biceps machine', 'biceps'],
    'machine_biceps_curl': ['biceps curl machine', 'bicep machine', 'biceps'],
    'cable_hammer_curl_rope': ['rope hammer curl', 'rope curl', 'hammer curl cable', 'biceps'],
    'tricep_pushdown_v_bar': ['v bar pushdown', 'tricep pushdown', 'pushdown', 'triceps'],
    'leg_press_45_degree': ['45 degree leg press', 'leg press', 'leg press machine', 'legs'],
    'horizontal_leg_press_seated': ['horizontal leg press', 'seated leg press', 'leg press', 'legs'],
    'leg_press_wide_stance': ['wide leg press', 'glute leg press', 'inner thigh', 'leg press'],
    'pendulum_squat': ['pendulum squat machine', 'squat machine', 'legs'],
    'glute_kickback_machine': ['glute kickback', 'kickback machine', 'glutes', 'booty'],
    'hip_thrust_machine': ['hip thrust machine', 'glute bridge machine', 'glutes', 'booty'],
    'smith_machine_hip_thrust': ['smith hip thrust', 'hip thrust', 'glutes'],
    'cable_hip_abduction': ['hip abduction cable', 'outer glutes', 'glutes'],
    'standing_leg_curl_machine': ['standing hamstring curl', 'leg curl', 'hamstrings'],
    'calf_press_machine': ['calf press', 'calf machine', 'calves'],
    'torso_rotation_machine': ['rotary torso', 'torso twist', 'oblique machine', 'abs'],
    'captains_chair_knee_raise': ["captain's chair", 'vertical knee raise', 'knee raise', 'abs'],
    'captains_chair_leg_raise': ["captain's chair", 'vertical leg raise', 'leg raise', 'abs'],
    'treadmill_run': ['treadmill', 'running', 'run', 'cardio'],
    'treadmill_jog': ['treadmill', 'jogging', 'jog', 'cardio'],
    'recumbent_bike': ['recumbent', 'exercise bike', 'cycle', 'cardio'],
    'spin_bike_indoor_cycling': ['spin', 'spinning', 'cycling', 'cycle', 'cardio'],
    'stair_mill_step_mill': ['stair climber', 'step mill', 'stairmaster', 'cardio'],
}

# The source's cardio-machine text is mostly calorie marketing; use short, practical steps instead.
STEP_OVERRIDE = {
    'treadmill_walk': [
        'Straddle the belt, clip the safety key to your clothing, and start at a slow speed.',
        'Build up to a brisk pace (about 4 to 6 km/h) where you breathe harder but can still talk.',
        'Stand tall with your chest up, swing your arms naturally, and avoid gripping the handrails.',
        'Slow down for the last few minutes to cool down before stepping off.'],
    'treadmill_jog': [
        'Straddle the belt, clip the safety key to your clothing, and start with a 3 to 5 minute walk to warm up.',
        'Raise the speed gradually to a comfortable jogging pace where you can still hold a conversation.',
        'Keep your posture tall with a slight forward lean, relaxed shoulders, and light, quiet steps.',
        'Avoid holding the handrails, and walk for a few minutes at the end to cool down.'],
    'treadmill_run': [
        'Straddle the belt, clip the safety key to your clothing, and warm up with 3 to 5 minutes of easy walking or jogging.',
        'Increase the speed to your running pace and keep your stride short and quick, landing with your foot under your hips.',
        'Stay tall with a slight forward lean, relaxed shoulders, and arms swinging at about 90 degrees.',
        'Use a 1 percent incline if you want it to feel closer to outdoor running, and avoid holding the handrails.',
        'Finish with a few minutes of walking to bring your heart rate down.'],
    'cycling_stationary': [
        'Set the saddle to about hip height so your knee has a slight bend at the bottom of each pedal stroke.',
        'Start with a 3 to 5 minute warm-up at low resistance and about 70 to 90 rpm.',
        'Increase the resistance until your legs work but your cadence stays smooth, keeping your back flat and shoulders relaxed.',
        'Finish with a few minutes of easy pedalling to cool down.'],
    'recumbent_bike': [
        'Adjust the seat so your knee has a slight bend when your leg is fully extended, and sit with your back against the seat.',
        'Warm up with a few minutes of easy pedalling at low resistance.',
        'Raise the resistance to a level you can hold at a steady cadence of 60 to 90 rpm.',
        'Keep your core lightly braced and finish with an easy cool-down.'],
    'elliptical': [
        'Step onto the pedals, grip the moving handles, and start at an easy resistance.',
        'Keep your chest tall and push and pull with your arms as you drive through your legs in a smooth oval motion.',
        'Press through your whole foot and avoid leaning heavily on the handles.',
        'Raise the resistance or incline for harder work, and cool down for a couple of minutes at the end.'],
    'stair_climber': [
        'Step onto the machine and start at a slow pace, holding the rails lightly for balance only.',
        'Stand tall and press through your whole foot on each step, without letting your heels hang off.',
        'Keep a steady rhythm and avoid leaning on the rails or letting your body weight hang from your arms.',
        'Raise the speed gradually and slow down for a cool-down at the end.'],
    'stair_mill_step_mill': [
        'Step onto the rotating stairs, hold the rails lightly, and start at a slow speed.',
        'Stand tall and place your whole foot on each step, driving through your heel and glutes.',
        'Keep a steady rhythm and avoid leaning heavily on the rails.',
        'Increase the speed gradually and slow down to cool off at the end.'],
    'rowing_machine': [
        'Sit on the rower, strap your feet in over the middle of your foot, and grip the handle with an overhand grip.',
        'Start at the catch with your shins vertical, arms straight, and back tall.',
        'Drive with your legs first, then lean back slightly, then pull the handle to your lower ribs.',
        'Recover in reverse: straighten your arms, hinge forward from the hips, then bend your knees to slide back to the start.',
        'Keep the drive powerful and the recovery slow, with the handle travelling in a straight line.'],
    'skipping_rope': [
        'Hold a handle in each hand with your elbows close to your sides and the rope behind your heels.',
        'Swing the rope over your head using your wrists, not your whole arms.',
        'Jump just high enough for the rope to pass under your feet and land softly on the balls of your feet.',
        'Keep your posture tall and a steady rhythm, resting when your form slips.'],
    'cycling_outdoor': [
        'Check your helmet, brakes, and tyres, and set the saddle so your knee has a slight bend at the bottom of the pedal stroke.',
        'Start pedalling at an easy pace to warm up, keeping your hands relaxed on the handlebars.',
        'Keep a steady cadence of 70 to 90 rpm and shift gears early so you do not grind.',
        'Obey traffic rules, stay visible, and cool down with a few easy minutes.'],
}

if __name__ == '__main__':
    main()
