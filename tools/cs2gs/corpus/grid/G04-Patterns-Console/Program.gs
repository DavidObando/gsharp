// G04-Patterns-Console: differential C#->G# conformance fixtures for pattern
// matching (ADR-0115). Deterministic stdout is the parity oracle. One pattern
// kind per file under Constructs/; Run() methods are invoked in file-name
// order.

package Corpus.Grid04

import Corpus.Grid04.Constructs

AndPatternFixture.Run()
CasePatternSwitchLabelFixture.Run()
ConstantPatternFixture.Run()
DeclarationPatternFixture.Run()
DiscardPatternFixture.Run()
ExpressionColonFixture.Run()
IsPatternExpressionFixture.Run()
ListPatternFixture.Run()
NotPatternFixture.Run()
OrPatternFixture.Run()
ParenthesizedPatternFixture.Run()
PositionalPatternClauseFixture.Run()
RecursivePatternFixture.Run()
RelationalPatternFixture.Run()
SwitchExpressionFixture.Run()
TypePatternFixture.Run()
