Continue the frozen full-pipeline evaluation in this same session. Run exactly the requested
workflow stage named below, following the repository skill for that stage. Do not use the network or
inspect paths outside the repository. When a material decision is required, return `needs-input`
with one concise question. Otherwise complete the stage and return `complete`. Always obey the
requested structured-output schema; set `question` to an empty string when complete.
