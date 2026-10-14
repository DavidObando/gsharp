### New Rules

Rule ID | Category | Severity | Notes
--------|----------|----------|-------
GSA0004 | GSharp.InternalAnalyzers | Warning | Emit caches keyed on symbols producing metadata references must include RemapScope
GSA0005 | GSharp.InternalAnalyzers | Warning | Preserve every member the base rewriter preserves when cloning a bound node
GSA0006 | GSharp.InternalAnalyzers | Warning | Walk StructSymbol.BaseClass through GetHierarchy() instead of by hand
GSA0007 | GSharp.InternalAnalyzers | Warning | Route CLR type conversions through the nullability funnel
