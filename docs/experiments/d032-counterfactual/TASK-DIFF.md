# Counterfactual task diff

The exact removal is shown below, including the following blank line. All other
bytes are unchanged. No replacement guidance or positive branching instruction
was introduced. The existing inventory lock-order constraints remain intact.

```diff
--- docs/experiments/d032/task.txt
+++ docs/experiments/d032-counterfactual/task.txt
@@ -159,3 +158,0 @@
-
-If a new lock-order protocol is required, stop and report the concrete issue
-before implementing broadly.
```
