# cs2gs C# construct coverage matrix

Generated from `tools/cs2gs/coverage/csharp-construct-inventory.json` by `cs2gs coverage --write`.
Drift fails `ConstructInventoryGoldenTests`. Do not edit by hand.

| Status | Count |
| --- | --- |
| Unclassified | 0 |
| Translated | 239 |
| Lowered | 19 |
| UnsupportedByDesign | 56 |
| Gap | 7 |

## Translated (239)

| Kind | Node type | Rule | Rationale | Fixture | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| AccessorList | AccessorListSyntax | ADR-0115 §B.11 |  |  |  |  |
| AddAccessorDeclaration | AccessorDeclarationSyntax | ADR-0052 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/EventDeclaration.cs |  | The explicit add/remove accessor body of an event declaration (ADR-0052 §2); translates like any other accessor body. |
| AddAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/AddAssignmentExpression.cs |  |  |
| AddExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/AddExpression.cs |  |  |
| AddressOfExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B.30 |  |  |  |  |
| AliasQualifiedName | AliasQualifiedNameSyntax | ADR-0115 §B.12 |  |  |  |  |
| AllowsConstraintClause | AllowsConstraintClauseSyntax | ADR-0115 §B.7 |  | tools/cs2gs/corpus/grid/G08-Generics-Console/Constructs/AllowsConstraintClause.cs |  | C#13 allows ref struct passes E2E (grid G08). |
| AndAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/AndAssignmentExpression.cs |  |  |
| AndPattern | BinaryPatternSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/AndPattern.cs |  |  |
| AnonymousMethodExpression | AnonymousMethodExpressionSyntax | ADR-0115 §B.20 |  | tools/cs2gs/corpus/grid/G09-Functions-Console/Constructs/AnonymousMethodExpression.cs |  |  |
| Argument | ArgumentSyntax | ADR-0115 §B |  |  |  |  |
| ArgumentList | ArgumentListSyntax | ADR-0115 §B |  |  |  |  |
| ArrayCreationExpression | ArrayCreationExpressionSyntax | ADR-0115 §B.16 |  | tools/cs2gs/corpus/grid/G05-Collections-Console/Constructs/ArrayCreationExpression.cs | https://github.com/DavidObando/gsharp/issues/1893 | 1-D/jagged green; rank>1 (issue #1893) flat-lowers a tracked local's rectangular `new T[d0, d1, ...]`/`new T[,]{{...}}` to a single backing array with hoisted per-dimension sizes, preserving every index (see ArrayCreationExpressionMultiDim.cs, parity-verified). An untracked rank>1 shape (field/parameter/no-initializer) reports the CS2GS-GAP instead of silently collapsing to 1-D. |
| ArrayInitializerExpression | InitializerExpressionSyntax | ADR-0115 §B.16 |  | tools/cs2gs/corpus/grid/G05-Collections-Console/Constructs/ArrayInitializerExpression.cs |  |  |
| ArrayRankSpecifier | ArrayRankSpecifierSyntax | ADR-0115 §B.16 |  |  |  |  |
| ArrayType | ArrayTypeSyntax | ADR-0115 §B.16 |  |  |  |  |
| ArrowExpressionClause | ArrowExpressionClauseSyntax | ADR-0115 §B.5 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/ArrowExpressionClause.cs |  | Expression-bodied members (ADR-0131). |
| AsExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/AsExpression.cs |  |  |
| Attribute | AttributeSyntax | ADR-0115 §B.11 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/AttributeList.cs |  | User-defined attribute classes blocked by gsc GS0200 (issue #1921). |
| AttributeArgument | AttributeArgumentSyntax | ADR-0115 §B.11 |  |  |  |  |
| AttributeArgumentList | AttributeArgumentListSyntax | ADR-0115 §B.11 |  |  |  |  |
| AttributeList | AttributeListSyntax | ADR-0115 §B.11 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/AttributeList.cs | https://github.com/DavidObando/gsharp/issues/1913 | BCL attributes and user-defined attribute classes (issue #1921, fixed) green; parameter attributes silently dropped and generic attributes emit non-parsing G# (issue #1913). |
| AttributeTargetSpecifier | AttributeTargetSpecifierSyntax | ADR-0115 §B.11 |  |  |  |  |
| AwaitExpression | AwaitExpressionSyntax | ADR-0115 §B.23 |  | tools/cs2gs/corpus/grid/G10-Async-Console/Constructs/AwaitExpression.cs |  | Task/Task<T> green incl. ConfigureAwait and await foreach; ValueTask blocked by gsc (issue #1918); async Main mislowers (issue #1904). |
| BaseConstructorInitializer | ConstructorInitializerSyntax | ADR-0115 §B.28 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/BaseConstructorInitializer.cs |  |  |
| BaseExpression | BaseExpressionSyntax | ADR-0115 §B |  |  |  | base.M() virtual calls (issue #986, resolved). |
| BaseList | BaseListSyntax | ADR-0115 §B.6 |  | tools/cs2gs/corpus/grid/G06-Types-Console/Constructs/BaseList.cs |  |  |
| BitwiseAndExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/BitwiseAndExpression.cs |  |  |
| BitwiseNotExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/BitwiseNotExpression.cs |  |  |
| BitwiseOrExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/BitwiseOrExpression.cs |  |  |
| Block | BlockSyntax | ADR-0115 §B.2 |  |  |  |  |
| BracketedArgumentList | BracketedArgumentListSyntax | ADR-0115 §B |  |  |  | Issue #942 (resolved). |
| BracketedParameterList | BracketedParameterListSyntax | ADR-0115 §B.11 |  |  |  | User indexers (issue #944). |
| BreakStatement | BreakStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/BreakStatement.cs |  |  |
| CasePatternSwitchLabel | CasePatternSwitchLabelSyntax | ADR-0115 §B.33 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/CasePatternSwitchLabel.cs |  |  |
| CaseSwitchLabel | CaseSwitchLabelSyntax | ADR-0115 §B.33 |  |  |  |  |
| CastExpression | CastExpressionSyntax | ADR-0115 §B.17 |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/CastExpression.cs |  |  |
| CatchClause | CatchClauseSyntax | ADR-0115 §B.27 |  |  |  |  |
| CatchDeclaration | CatchDeclarationSyntax | ADR-0115 §B.27 |  |  |  |  |
| CatchFilterClause | CatchFilterClauseSyntax | ADR-0115 §B.27 |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/CatchFilterClause.cs |  | A when-filter with an overlapping later sibling catch has no faithful lowering (issue #1724 area). |
| CharacterLiteralExpression | LiteralExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G01-Literals-Console/Constructs/CharacterLiteralExpression.cs |  |  |
| CheckedExpression | CheckedExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/CheckedExpression.cs | https://github.com/DavidObando/gsharp/issues/1881 |  |
| CheckedStatement | CheckedStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/CheckedStatement.cs | https://github.com/DavidObando/gsharp/issues/1881 | gsc gained native checked/unchecked expression + block support (issue #1881); overflow semantics preserved, including the overflow-in-try/catch(OverflowException) sub-case. Stdout parity verified (grid G03). |
| ClassConstraint | ClassOrStructConstraintSyntax | ADR-0115 §B.7 |  | tools/cs2gs/corpus/grid/G08-Generics-Console/Constructs/ClassConstraint.cs |  |  |
| ClassDeclaration | ClassDeclarationSyntax | ADR-0115 §B.4 |  | tools/cs2gs/corpus/grid/G06-Types-Console/Constructs/ClassDeclaration.cs |  | C#12 primary ctors now map to native G# primary constructors (issue #1909, resolved); partial parts across multiple declarations/files now merge into one G# type declaration (issue #1910, resolved). |
| CoalesceAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/CoalesceAssignmentExpression.cs |  | Nullable value-type targets now emit verifiable IL (issue #1916, resolved); reference and value-type forms are both green. |
| CoalesceExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/CoalesceExpression.cs |  | Binary ?? (issue #941, resolved). |
| CollectionExpression | CollectionExpressionSyntax | ADR-0115 §B.36 |  | tools/cs2gs/corpus/grid/G05-Collections-Console/Constructs/CollectionExpression.cs | https://github.com/DavidObando/gsharp/issues/1897 | Array targets green; List<T> targets fail conversion; spread unsupported (issues #1897). |
| CollectionInitializerExpression | InitializerExpressionSyntax | ADR-0115 §B.16 |  | tools/cs2gs/corpus/grid/G05-Collections-Console/Constructs/CollectionInitializerExpression.cs |  |  |
| CompilationUnit | CompilationUnitSyntax | ADR-0115 §B.1 |  |  |  |  |
| ComplexElementInitializerExpression | InitializerExpressionSyntax | ADR-0115 §B.16 |  | tools/cs2gs/corpus/grid/G05-Collections-Console/Constructs/CollectionInitializerExpression.cs |  |  |
| ConditionalAccessExpression | ConditionalAccessExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/ConditionalAccessExpression.cs |  | Null-conditional ?. / ?[. |
| ConditionalExpression | ConditionalExpressionSyntax | ADR-0115 §B.26 |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/ConditionalExpression.cs |  |  |
| ConstantPattern | ConstantPatternSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/ConstantPattern.cs | https://github.com/DavidObando/gsharp/issues/1923 | Boxed-object subjects fail in gsc (issue #1923); typed subjects green. |
| ConstructorConstraint | ConstructorConstraintSyntax | ADR-0115 §B.7 |  | tools/cs2gs/corpus/grid/G08-Generics-Console/Constructs/ConstructorConstraint.cs |  | new T() under new() works (past gap #988 resolved). |
| ConstructorDeclaration | ConstructorDeclarationSyntax | ADR-0115 §B.28 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/ConstructorDeclaration.cs |  |  |
| ContinueStatement | ContinueStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/ContinueStatement.cs |  |  |
| ConversionOperatorDeclaration | ConversionOperatorDeclarationSyntax | ADR-0115 §B.31 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/ConversionOperatorDeclaration.cs |  |  |
| DeclarationExpression | DeclarationExpressionSyntax | ADR-0115 §B.30 |  | tools/cs2gs/corpus/grid/G09-Functions-Console/Constructs/DeclarationExpression.cs |  |  |
| DeclarationPattern | DeclarationPatternSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/DeclarationPattern.cs |  | x is T t binder (issue #993, resolved). |
| DefaultConstraint | DefaultConstraintSyntax | ADR-0115 §B.7 |  | tools/cs2gs/corpus/grid/G08-Generics-Console/Constructs/DefaultConstraint.cs |  | Translates to an unconstrained G# [T]; gsc override/inference bug fixed (issue #1931). |
| DefaultExpression | DefaultExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/DefaultExpression.cs |  |  |
| DefaultLiteralExpression | LiteralExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G01-Literals-Console/Constructs/DefaultLiteralExpression.cs |  |  |
| DefaultSwitchLabel | DefaultSwitchLabelSyntax | ADR-0115 §B.33 |  |  |  |  |
| DelegateDeclaration | DelegateDeclarationSyntax | ADR-0059 |  | tools/cs2gs/corpus/grid/G09-Functions-Console/Constructs/DelegateDeclaration.cs |  | Maps to the G# named delegate type alias `type Name = delegate func(params) R` (ADR-0059), including a generic delegate's type-parameter list (any arity, with constraints) — `type Name[T constraint] = delegate func(...) R` (issue #1960 item 1). |
| DestructorDeclaration | DestructorDeclarationSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G06-Types-Console/Constructs/DestructorDeclaration.cs |  |  |
| DiscardDesignation | DiscardDesignationSyntax | ADR-0115 §B.30 |  | tools/cs2gs/corpus/grid/G09-Functions-Console/Constructs/DeclarationExpression.cs |  |  |
| DiscardPattern | DiscardPatternSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/DiscardPattern.cs |  |  |
| DivideAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/DivideAssignmentExpression.cs |  |  |
| DivideExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/DivideExpression.cs |  |  |
| DoStatement | DoStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/DoStatement.cs |  |  |
| ElementAccessExpression | ElementAccessExpressionSyntax | ADR-0115 §B |  |  |  | Issue #942 (resolved). |
| ElementBindingExpression | ElementBindingExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/ElementBindingExpression.cs |  | Null-conditional ?. / ?[. |
| ElseClause | ElseClauseSyntax | ADR-0115 §B |  |  |  |  |
| EmptyStatement | EmptyStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/EmptyStatement.cs |  |  |
| EnumDeclaration | EnumDeclarationSyntax | ADR-0115 §B.11 |  | tools/cs2gs/corpus/grid/G06-Types-Console/Constructs/EnumDeclaration.cs |  | Member values (explicit or implicit) and [Flags] are preserved (issue #1912, fixed). |
| EnumMemberDeclaration | EnumMemberDeclarationSyntax | ADR-0115 §B.11 |  | tools/cs2gs/corpus/grid/G06-Types-Console/Constructs/EnumMemberDeclaration.cs |  | Explicit/negative/[Flags] bit-shift-or/alias values resolve via the semantic model's IFieldSymbol.ConstantValue and are emitted as an explicit G# `= value` (new language feature, issue #1912, fixed). |
| EqualsExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/EqualsExpression.cs |  |  |
| EqualsValueClause | EqualsValueClauseSyntax | ADR-0115 §B.3 |  |  |  |  |
| EventDeclaration | EventDeclarationSyntax | ADR-0052 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/EventDeclaration.cs |  | Explicit add/remove accessor event maps to the G# event declaration's explicit-accessor form (ADR-0052 §2); a source-declared named delegate handler type keeps its name (issue #1960 item 3) instead of the anonymous arrow form. |
| EventFieldDeclaration | EventFieldDeclarationSyntax | ADR-0052 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/EventFieldDeclaration.cs |  | Field-like event maps to the G# field-like event declaration (ADR-0052 §2); a source-declared named delegate handler type keeps its name (issue #1960 item 3) instead of the anonymous arrow form. |
| ExclusiveOrAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/ExclusiveOrAssignmentExpression.cs |  |  |
| ExclusiveOrExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/ExclusiveOrExpression.cs |  |  |
| ExpressionColon | ExpressionColonSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/ExpressionColon.cs | https://github.com/DavidObando/gsharp/issues/1891 | is-form green; switch-expression arm form unsupported (issue #1891). |
| ExpressionElement | ExpressionElementSyntax | ADR-0115 §B.36 |  | tools/cs2gs/corpus/grid/G05-Collections-Console/Constructs/CollectionExpression.cs |  |  |
| ExpressionStatement | ExpressionStatementSyntax | ADR-0115 §B |  |  |  |  |
| ExtensionBlockDeclaration | ExtensionBlockDeclarationSyntax | ADR-0115 §B.19 |  | tools/cs2gs/corpus/grid/G13-Extensions-Console/Constructs/ExtensionBlockDeclaration.cs | https://github.com/DavidObando/gsharp/issues/1879 | C# 14 `extension(T x)`/`extension(T)` block members map onto the same target as a classic this-param extension method (ADR-0115 §B.19): an instance method/property lowers to a receiver-clause func (a property becomes a get-only func, since G#'s prop grammar has no receiver clause, with call sites rewritten to a zero-arg call); a static member becomes a plain shared member of the declaring class, with call sites rewritten from the extended type's name to the real owner. An enum receiver and a settable instance extension property are each reported as an explicit gap (grid G13). |
| FalseLiteralExpression | LiteralExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G01-Literals-Console/Constructs/FalseLiteralExpression.cs |  |  |
| FieldDeclaration | FieldDeclarationSyntax | ADR-0115 §B.3 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/FieldDeclaration.cs |  |  |
| FieldExpression | FieldExpressionSyntax | ADR-0051 §2 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/FieldExpression.cs |  |  |
| FileScopedNamespaceDeclaration | FileScopedNamespaceDeclarationSyntax | ADR-0115 §B.1 |  |  |  |  |
| FinallyClause | FinallyClauseSyntax | ADR-0115 §B.27 |  |  |  |  |
| FixedStatement | FixedStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G12-Unsafe-Console/Constructs/FixedStatement.cs | https://github.com/DavidObando/gsharp/issues/1933 | Compiles end-to-end under the ilverify allow-unsafe policy (issue #1933); IL is unverifiable by design, not a gsc defect. |
| ForEachStatement | ForEachStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/ForEachStatement.cs |  |  |
| ForEachVariableStatement | ForEachVariableStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G05-Collections-Console/Constructs/TupleExpression.cs | https://github.com/DavidObando/gsharp/issues/1922 | Sync foreach tuple-deconstruction translates to first-class G# `for (a, b) in xs`; ValueTuple deconstruction now supported by gsc (issue #1922 fixed). await foreach still lowers via temp+let (no first-class async form). |
| FunctionPointerCallingConvention | FunctionPointerCallingConventionSyntax | ADR-0122 §9 / ADR-0095 |  | tools/cs2gs/corpus/grid/G12-Unsafe-Console/Constructs/FunctionPointerType.cs | https://github.com/DavidObando/gsharp/issues/1906 | managed/`managed`/`unmanaged[Cdecl|Stdcall|Thiscall|Fastcall]` translate; bare `unmanaged` (platform-default ABI) and combined/custom conventions stay an Unsupported/ByDesign sub-case (no fixed G# CallingConvention equivalent). |
| FunctionPointerParameter | FunctionPointerParameterSyntax | ADR-0122 §9 / ADR-0095 |  | tools/cs2gs/corpus/grid/G12-Unsafe-Console/Constructs/FunctionPointerType.cs | https://github.com/DavidObando/gsharp/issues/1906 |  |
| FunctionPointerParameterList | FunctionPointerParameterListSyntax | ADR-0122 §9 / ADR-0095 |  | tools/cs2gs/corpus/grid/G12-Unsafe-Console/Constructs/FunctionPointerType.cs | https://github.com/DavidObando/gsharp/issues/1906 |  |
| FunctionPointerType | FunctionPointerTypeSyntax | ADR-0122 §9 / ADR-0095 |  | tools/cs2gs/corpus/grid/G12-Unsafe-Console/Constructs/FunctionPointerType.cs | https://github.com/DavidObando/gsharp/issues/1906 | delegate*<...>/delegate* managed<...> map to G#'s managed `*func(T) R`; delegate* unmanaged[Cdecl|Stdcall|Thiscall|Fastcall]<...> maps to G#'s raw `unmanaged[CC] (T) -> R`. Bare `delegate* unmanaged<...>` and a combined/custom `[CC]` list are an Unsupported/ByDesign sub-case (issue #1906). |
| FunctionPointerUnmanagedCallingConvention | FunctionPointerUnmanagedCallingConventionSyntax | ADR-0095 |  | tools/cs2gs/corpus/grid/G12-Unsafe-Console/Constructs/FunctionPointerType.cs | https://github.com/DavidObando/gsharp/issues/1906 |  |
| FunctionPointerUnmanagedCallingConventionList | FunctionPointerUnmanagedCallingConventionListSyntax | ADR-0095 |  | tools/cs2gs/corpus/grid/G12-Unsafe-Console/Constructs/FunctionPointerType.cs | https://github.com/DavidObando/gsharp/issues/1906 |  |
| GenericName | GenericNameSyntax | ADR-0115 §B.7 |  | tools/cs2gs/corpus/grid/G08-Generics-Console/Constructs/GenericName.cs |  |  |
| GetAccessorDeclaration | AccessorDeclarationSyntax | ADR-0115 §B.11 |  |  |  |  |
| GlobalStatement | GlobalStatementSyntax | ADR-0115 §B.11 |  |  |  | Entry-class hoisting (T3): top-level statements. |
| GotoStatement | GotoStatementSyntax | ADR-0139 |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/GotoStatement.cs |  |  |
| GreaterThanExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/GreaterThanExpression.cs |  |  |
| GreaterThanOrEqualExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/GreaterThanOrEqualExpression.cs |  |  |
| IdentifierName | IdentifierNameSyntax | ADR-0115 §B.12 |  |  |  |  |
| IfStatement | IfStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/IfStatement.cs |  |  |
| ImplicitArrayCreationExpression | ImplicitArrayCreationExpressionSyntax | ADR-0115 §B.16 |  | tools/cs2gs/corpus/grid/G05-Collections-Console/Constructs/ImplicitArrayCreationExpression.cs |  |  |
| ImplicitObjectCreationExpression | ImplicitObjectCreationExpressionSyntax | ADR-0115 §B.25 |  | tools/cs2gs/corpus/grid/G05-Collections-Console/Constructs/ObjectCreationExpression.cs |  |  |
| IndexExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B.36 |  | tools/cs2gs/corpus/grid/G05-Collections-Console/Constructs/IndexExpression.cs | https://github.com/DavidObando/gsharp/issues/1894 | Inline ^i green; Index-typed locals mis-lower (issue #1894, runtime crash). |
| IndexerDeclaration | IndexerDeclarationSyntax | ADR-0115 §B.11 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/IndexerDeclaration.cs |  | User indexers (issue #944). |
| InitAccessorDeclaration | AccessorDeclarationSyntax | ADR-0115 §B.11 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/InitAccessorDeclaration.cs |  |  |
| InterfaceDeclaration | InterfaceDeclarationSyntax | ADR-0115 §B.4 |  | tools/cs2gs/corpus/grid/G06-Types-Console/Constructs/InterfaceDeclaration.cs |  |  |
| InterpolatedStringExpression | InterpolatedStringExpressionSyntax | ADR-0115 §B.9 |  | tools/cs2gs/corpus/grid/G14-Strings-Console/Constructs/InterpolatedStringExpression.cs |  |  |
| InterpolatedStringText | InterpolatedStringTextSyntax | ADR-0115 §B.9 |  | tools/cs2gs/corpus/grid/G14-Strings-Console/Constructs/InterpolatedStringText.cs | https://github.com/DavidObando/gsharp/issues/1882 | Brace escapes {{ }} copied verbatim — parity-verified divergence (issue #1882). |
| Interpolation | InterpolationSyntax | ADR-0115 §B.9 |  | tools/cs2gs/corpus/grid/G14-Strings-Console/Constructs/Interpolation.cs |  |  |
| InterpolationAlignmentClause | InterpolationAlignmentClauseSyntax | ADR-0115 §B.9 |  | tools/cs2gs/corpus/grid/G14-Strings-Console/Constructs/InterpolationAlignmentClause.cs |  |  |
| InterpolationFormatClause | InterpolationFormatClauseSyntax | ADR-0115 §B.9 |  | tools/cs2gs/corpus/grid/G14-Strings-Console/Constructs/InterpolationFormatClause.cs |  |  |
| InvocationExpression | InvocationExpressionSyntax | ADR-0115 §B |  |  |  |  |
| IsExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/IsExpression.cs |  |  |
| IsPatternExpression | IsPatternExpressionSyntax | ADR-0115 §B.36 |  |  |  |  |
| LabeledStatement | LabeledStatementSyntax | ADR-0139 |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/LabeledStatement.cs |  |  |
| LeftShiftAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/LeftShiftAssignmentExpression.cs |  |  |
| LeftShiftExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/LeftShiftExpression.cs |  |  |
| LessThanExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/LessThanExpression.cs |  |  |
| LessThanOrEqualExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/LessThanOrEqualExpression.cs |  |  |
| ListPattern | ListPatternSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/ListPattern.cs |  | is-test path lowers to a length test (`==` exact / `>=` with a slice) ANDed with per-element index tests; switch-arm path emits a native G# `ListPattern` (`[1, .., 4]`) since gsc has its own structural list-pattern matching (issue #1889, resolved). Element `var` binders reuse the #1888 discard+substitution mechanism; `int x` declaration-pattern elements map to native `TypePattern`. Deferral: gsc's `BindListPattern` only accepts array/slice-typed discriminants (not e.g. `List<T>`), a pre-existing gsc scope boundary, not a cs2gs limitation. |
| LocalDeclarationStatement | LocalDeclarationStatementSyntax | ADR-0115 §B.3 |  |  |  |  |
| LocalFunctionStatement | LocalFunctionStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/LocalFunctionStatement.cs |  | Static local functions call through their `let` binding directly; generic local functions translate to G#'s `let Name[T, ...] = func (...) ... { ... }` (issue #1886, fixed). |
| LockStatement | LockStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/LockStatement.cs |  |  |
| LogicalAndExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/LogicalAndExpression.cs |  |  |
| LogicalNotExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/LogicalNotExpression.cs |  |  |
| LogicalOrExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/LogicalOrExpression.cs |  |  |
| MemberBindingExpression | MemberBindingExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/MemberBindingExpression.cs |  | Null-conditional ?. / ?[. |
| MethodDeclaration | MethodDeclarationSyntax | ADR-0115 §B.5 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/MethodDeclaration.cs |  | Receiver-clause functions now retain their G# extension semantics across compiled assembly references (issue #1929). |
| ModuloAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/ModuloAssignmentExpression.cs |  |  |
| ModuloExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/ModuloExpression.cs |  |  |
| MultiplyAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/MultiplyAssignmentExpression.cs |  |  |
| MultiplyExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/MultiplyExpression.cs |  |  |
| NameColon | NameColonSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G09-Functions-Console/Constructs/NameColon.cs |  | Named arguments use the G# name: value form (ADR-0080). |
| NameEquals | NameEqualsSyntax | ADR-0115 §B.16 |  |  |  |  |
| NamespaceDeclaration | NamespaceDeclarationSyntax | ADR-0115 §B.1 |  |  |  |  |
| NotEqualsExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/NotEqualsExpression.cs |  |  |
| NotPattern | UnaryPatternSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/NotPattern.cs |  |  |
| NullLiteralExpression | LiteralExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G01-Literals-Console/Constructs/NullLiteralExpression.cs |  |  |
| NullableType | NullableTypeSyntax | ADR-0115 §B.12 |  |  |  | T? maps to G# nullable spelling. |
| NumericLiteralExpression | LiteralExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G01-Literals-Console/Constructs/NumericLiteralExpression.cs |  |  |
| ObjectCreationExpression | ObjectCreationExpressionSyntax | ADR-0115 §B.16 |  | tools/cs2gs/corpus/grid/G05-Collections-Console/Constructs/ObjectCreationExpression.cs |  |  |
| ObjectInitializerExpression | InitializerExpressionSyntax | ADR-0115 §B.11 |  | tools/cs2gs/corpus/grid/G05-Collections-Console/Constructs/ObjectCreationExpression.cs |  |  |
| OmittedArraySizeExpression | OmittedArraySizeExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G05-Collections-Console/Constructs/OmittedArraySizeExpression.cs |  |  |
| OmittedTypeArgument | OmittedTypeArgumentSyntax | ADR-0115 §B.7 |  | tools/cs2gs/corpus/grid/G08-Generics-Console/Constructs/OmittedTypeArgument.cs |  | nameof(List<>)/typeof(List<>) forms green (C#14); typeof of an unbound generic emits the bare generic-definition name (typeof(List)), which gsc's binder now resolves via arity-suffixed CLR lookup (issue #1915, fixed). |
| OperatorDeclaration | OperatorDeclarationSyntax | ADR-0115 §B.31 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/OperatorDeclaration.cs |  | C#14 instance compound-assignment operators (op_AdditionAssignment and siblings) have no canonical G# form and are reported as a loud CS2GS-GAP instead of emitting invalid `operator +=` syntax (issue #1908, fixed; tracked as a known/open gap in tools/cs2gs/triage/gaps.json, grid app G07); Equals(object) is-pattern override fails ilverify (issue #1917). |
| OrAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/OrAssignmentExpression.cs |  |  |
| OrPattern | BinaryPatternSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/OrPattern.cs |  |  |
| Parameter | ParameterSyntax | ADR-0115 §B.5 |  |  |  |  |
| ParameterList | ParameterListSyntax | ADR-0115 §B.5 |  |  |  |  |
| ParenthesizedExpression | ParenthesizedExpressionSyntax | ADR-0115 §B |  |  |  |  |
| ParenthesizedLambdaExpression | ParenthesizedLambdaExpressionSyntax | ADR-0115 §B.20 |  | tools/cs2gs/corpus/grid/G09-Functions-Console/Constructs/ParenthesizedLambdaExpression.cs | https://github.com/DavidObando/gsharp/issues/1901 | Lambda default parameters dropped (issue #1901); async lambdas blocked by gsc ICE (issue #1919). |
| ParenthesizedPattern | ParenthesizedPatternSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/ParenthesizedPattern.cs |  |  |
| ParenthesizedVariableDesignation | ParenthesizedVariableDesignationSyntax | ADR-0115 §B.30 |  |  |  |  |
| PointerIndirectionExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G12-Unsafe-Console/Constructs/FixedStatement.cs | https://github.com/DavidObando/gsharp/issues/1933 | Compiles; ilverify-by-design (issue #1933). *(p + i) dereference of parenthesized pointer arithmetic, including as a compound-assignment target/RHS, fixed in gsc (issue #1925). |
| PointerType | PointerTypeSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G12-Unsafe-Console/Constructs/PointerType.cs | https://github.com/DavidObando/gsharp/issues/1933 | Compiles end-to-end under the ilverify allow-unsafe policy (issue #1933); pointer IL is unverifiable by design, not a gsc defect. |
| PositionalPatternClause | PositionalPatternClauseSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/PositionalPatternClause.cs | https://github.com/DavidObando/gsharp/issues/1887 | Fixed (was SILENT MISTRANSLATION, issue #1887): a positional subpattern lowers to the same member-access form a property subpattern uses (tuple Item1/Item2, or a record's property via its Deconstruct). Switch-expression bare positional patterns over a raw TUPLE are also supported: gsc's property-pattern binder/emitter/evaluator now accept a ValueTuple subject (previously GS0172). |
| PostDecrementExpression | PostfixUnaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/PostDecrementExpression.cs |  |  |
| PostIncrementExpression | PostfixUnaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/PostIncrementExpression.cs |  |  |
| PreDecrementExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/PreDecrementExpression.cs |  |  |
| PreIncrementExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/PreIncrementExpression.cs |  |  |
| PredefinedType | PredefinedTypeSyntax | ADR-0115 §B.12 |  |  |  |  |
| PrimaryConstructorBaseType | PrimaryConstructorBaseTypeSyntax | ADR-0065 §5 |  | tools/cs2gs/corpus/grid/G06-Types-Console/Constructs/PrimaryConstructorBaseType.cs |  | A derived primary-ctor class's `: Base(arg)` forwarding call now maps to the G# base-call form `class Derived(...) : Base(args) { ... }` (issue #1909, resolved). |
| PropertyDeclaration | PropertyDeclarationSyntax | ADR-0115 §B.11 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/PropertyDeclaration.cs |  |  |
| PropertyPatternClause | PropertyPatternClauseSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/RecursivePattern.cs |  | Property sub-patterns; designator collisions fixed in issue #1839. |
| QualifiedName | QualifiedNameSyntax | ADR-0115 §B.12 |  |  |  |  |
| RecordDeclaration | RecordDeclarationSyntax | ADR-0115 §B.4 |  | tools/cs2gs/corpus/grid/G06-Types-Console/Constructs/RecordDeclaration.cs |  | with-expressions blocked by initializer bug (issue #1892). |
| RecordStructDeclaration | RecordDeclarationSyntax | ADR-0115 §B.4 |  | tools/cs2gs/corpus/grid/G06-Types-Console/Constructs/RecordStructDeclaration.cs |  |  |
| RecursivePattern | RecursivePatternSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/RecursivePattern.cs | https://github.com/DavidObando/gsharp/issues/1923 | Shallow property patterns green; nested reference-member and boxed/nullable subjects blocked by gsc (issue #1923). |
| RefStructConstraint | RefStructConstraintSyntax | ADR-0115 §B.7 |  | tools/cs2gs/corpus/grid/G08-Generics-Console/Constructs/AllowsConstraintClause.cs |  |  |
| RelationalPattern | RelationalPatternSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/RelationalPattern.cs |  |  |
| RemoveAccessorDeclaration | AccessorDeclarationSyntax | ADR-0052 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/EventDeclaration.cs |  | The explicit add/remove accessor body of an event declaration (ADR-0052 §2); translates like any other accessor body. |
| ReturnStatement | ReturnStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/ReturnStatement.cs |  |  |
| RightShiftAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/RightShiftAssignmentExpression.cs |  |  |
| RightShiftExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/RightShiftExpression.cs |  |  |
| ScopedType | ScopedTypeSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G12-Unsafe-Console/Constructs/ScopedType.cs |  | scoped Span/scoped ref parameters translate and verify (grid G12). |
| SetAccessorDeclaration | AccessorDeclarationSyntax | ADR-0115 §B.11 |  |  |  |  |
| SimpleAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/SimpleAssignmentExpression.cs | https://github.com/DavidObando/gsharp/issues/1895, https://github.com/DavidObando/gsharp/issues/1974 | Deconstruction-assignment into existing locals emits let bindings (issue #1895); generalized to expression position and nested targets (issue #1974). |
| SimpleBaseType | SimpleBaseTypeSyntax | ADR-0115 §B.6 |  | tools/cs2gs/corpus/grid/G06-Types-Console/Constructs/SimpleBaseType.cs |  |  |
| SimpleLambdaExpression | SimpleLambdaExpressionSyntax | ADR-0115 §B.20 |  | tools/cs2gs/corpus/grid/G09-Functions-Console/Constructs/SimpleLambdaExpression.cs |  |  |
| SimpleMemberAccessExpression | MemberAccessExpressionSyntax | ADR-0115 §B |  |  |  |  |
| SingleVariableDesignation | SingleVariableDesignationSyntax | ADR-0115 §B.30 |  | tools/cs2gs/corpus/grid/G09-Functions-Console/Constructs/DeclarationExpression.cs |  |  |
| SizeOfExpression | SizeOfExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G12-Unsafe-Console/Constructs/SizeOfExpression.cs |  |  |
| SlicePattern | SlicePatternSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/ListPattern.cs |  | is-test path materializes the slice-bound value via native G# range slicing (`receiver[prefix..^suffix]`, using new `RangeIndexExpression`/`FromEndIndexExpression` CodeModel nodes) and binds it by substitution; switch-arm path emits a native G# `SlicePattern` (`..rest`/`..`) since gsc has real runtime slice-capture support (issue #1889, resolved). |
| StackAllocArrayCreationExpression | StackAllocArrayCreationExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G12-Unsafe-Console/Constructs/StackAllocArrayCreationExpression.cs | https://github.com/DavidObando/gsharp/issues/1933 | Compiles end-to-end under the ilverify allow-unsafe policy (issue #1933); stackalloc's localloc IL is unverifiable by design, not a gsc defect. |
| StringLiteralExpression | LiteralExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G01-Literals-Console/Constructs/StringLiteralExpression.cs |  |  |
| StructConstraint | ClassOrStructConstraintSyntax | ADR-0115 §B.7 |  | tools/cs2gs/corpus/grid/G08-Generics-Console/Constructs/StructConstraint.cs |  |  |
| StructDeclaration | StructDeclarationSyntax | ADR-0115 §B.4 |  | tools/cs2gs/corpus/grid/G06-Types-Console/Constructs/StructDeclaration.cs |  | Generic-struct ctor zip now matches non-generic structs (issue #1915, fixed: comparisons keyed by parameter ordinal + OriginalDefinition instead of constructed-type identity). Cross-assembly G# metadata now preserves imported data-struct / primary-constructor semantics (issue #1929). |
| Subpattern | SubpatternSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/RecursivePattern.cs |  | Property sub-patterns; designator collisions fixed in issue #1839. |
| SubtractAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/SubtractAssignmentExpression.cs |  |  |
| SubtractExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/SubtractExpression.cs |  |  |
| SuppressNullableWarningExpression | PostfixUnaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/SuppressNullableWarningExpression.cs |  | x! maps to the G# !! assertion. |
| SwitchExpression | SwitchExpressionSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/SwitchExpression.cs |  |  |
| SwitchExpressionArm | SwitchExpressionArmSyntax | ADR-0115 §B.22 |  |  |  |  |
| SwitchSection | SwitchSectionSyntax | ADR-0115 §B.33 |  |  |  |  |
| SwitchStatement | SwitchStatementSyntax | ADR-0115 §B.33 |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/SwitchStatement.cs |  |  |
| ThisConstructorInitializer | ConstructorInitializerSyntax | ADR-0115 §B.28 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/ThisConstructorInitializer.cs |  |  |
| ThisExpression | ThisExpressionSyntax | ADR-0115 §B |  |  |  |  |
| ThrowExpression | ThrowExpressionSyntax | ADR-0115 §B.27 |  |  |  |  |
| ThrowStatement | ThrowStatementSyntax | ADR-0115 §B.27 |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/ThrowStatement.cs |  |  |
| TrueLiteralExpression | LiteralExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G01-Literals-Console/Constructs/TrueLiteralExpression.cs |  |  |
| TryStatement | TryStatementSyntax | ADR-0115 §B.27 |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/TryStatement.cs |  |  |
| TupleElement | TupleElementSyntax | ADR-0115 §B.12 |  |  |  | G# tuple types (T1, T2). |
| TupleExpression | TupleExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G05-Collections-Console/Constructs/TupleExpression.cs |  |  |
| TupleType | TupleTypeSyntax | ADR-0115 §B.12 |  |  |  | G# tuple types (T1, T2). |
| TypeArgumentList | TypeArgumentListSyntax | ADR-0115 §B.7 |  | tools/cs2gs/corpus/grid/G08-Generics-Console/Constructs/TypeArgumentList.cs |  |  |
| TypeConstraint | TypeConstraintSyntax | ADR-0115 §B.7 |  | tools/cs2gs/corpus/grid/G08-Generics-Console/Constructs/TypeConstraint.cs |  |  |
| TypeOfExpression | TypeOfExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/TypeOfExpression.cs |  |  |
| TypeParameter | TypeParameterSyntax | ADR-0115 §B.7 |  | tools/cs2gs/corpus/grid/G08-Generics-Console/Constructs/TypeParameter.cs |  | Declaration-site variance (out/in) conversions: gsc issue #1927 (fixed). |
| TypeParameterConstraintClause | TypeParameterConstraintClauseSyntax | ADR-0115 §B.7 |  |  |  |  |
| TypeParameterList | TypeParameterListSyntax | ADR-0115 §B.7 |  | tools/cs2gs/corpus/grid/G08-Generics-Console/Constructs/TypeParameterList.cs |  | Generic class + primary ctor ICEs gsc (issue #1920). |
| TypePattern | TypePatternSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/TypePattern.cs |  | Bare-type switch-arm (`int =>`, no binder — issue #1890, resolved): lowers to G#'s own discard-designator type pattern `_ is T` (`PatternBinder.BindTypePattern`'s `isDiscard` check), since gsc's own `TypePattern` grammar always requires a designator token before `is` but treats `_` as a non-binding discard there. Roslyn parses a bare user-type name (e.g. `Widget =>`) as a `ConstantPatternSyntax` over an identifier rather than `TypePatternSyntax`; the switch-arm path now shares the boolean-test path's `IsTypeReferencePattern` type-vs-constant disambiguation to still route it to `_ is T`. |
| UnaryMinusExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/UnaryMinusExpression.cs |  |  |
| UnaryPlusExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/UnaryPlusExpression.cs |  |  |
| UncheckedExpression | CheckedExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/UncheckedExpression.cs | https://github.com/DavidObando/gsharp/issues/1881 |  |
| UncheckedStatement | CheckedStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/UncheckedStatement.cs | https://github.com/DavidObando/gsharp/issues/1881 | Wrap-around parity verified (grid G03). |
| UnsafeStatement | UnsafeStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G12-Unsafe-Console/Constructs/UnsafeStatement.cs |  |  |
| UnsignedRightShiftAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/UnsignedRightShiftAssignmentExpression.cs |  |  |
| UnsignedRightShiftExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/UnsignedRightShiftExpression.cs |  |  |
| UsingDirective | UsingDirectiveSyntax | ADR-0115 §B.1 |  | tools/cs2gs/corpus/grid/G06-Types-Console/Constructs/TypeAliasDeclaration.cs | https://github.com/DavidObando/gsharp/issues/1914 | Plain + simple-alias green; alias-any-type (C#12) tuple-RHS green too (issue #1914; array/pointer/nullable-value-type RHS forms remain unexercised). |
| UsingStatement | UsingStatementSyntax | ADR-0115 §B.29 |  | tools/cs2gs/corpus/grid/G10-Async-Console/Constructs/UsingStatement.cs |  | await using preserves async-dispose semantics (fixed, issue #1903): lowers to G#'s own await using let form, binding IAsyncDisposable.DisposeAsync instead of plain using let/Dispose. |
| Utf8StringLiteralExpression | LiteralExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G01-Literals-Console/Constructs/Utf8StringLiteralExpression.cs |  | C# 11 u8 literals translate and reach parity (grid G01). |
| VarPattern | VarPatternSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/SwitchExpression.cs |  | Always-matching bind (issue #1888, resolved): an is-pattern/loop-condition `x is var v` lowers to the literal `true` test with `v` bound directly to the receiver; a switch/property-pattern `var v` arm lowers to the G# discard `_` (gsc's own total-arm check) with `v` bound via translator-side substitution to the arm's discriminant/property receiver. |
| VariableDeclaration | VariableDeclarationSyntax | ADR-0115 §B.3 |  |  |  |  |
| VariableDeclarator | VariableDeclaratorSyntax | ADR-0115 §B.3 |  |  |  |  |
| WhenClause | WhenClauseSyntax | ADR-0115 §B.22 |  |  |  | Pattern guards (issue #991, resolved). |
| WhileStatement | WhileStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/WhileStatement.cs |  |  |
| WithExpression | WithExpressionSyntax | ADR-0115 §B.4 |  | tools/cs2gs/corpus/grid/G06-Types-Console/Constructs/RecordDeclaration.cs |  |  |
| WithInitializerExpression | InitializerExpressionSyntax | ADR-0115 §B.4 |  | tools/cs2gs/corpus/grid/G06-Types-Console/Constructs/RecordDeclaration.cs |  |  |
| YieldBreakStatement | YieldStatementSyntax | ADR-0115 §B.34 |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/YieldBreakStatement.cs |  | Issue #994 (resolved). |
| YieldReturnStatement | YieldStatementSyntax | ADR-0115 §B.34 |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/YieldReturnStatement.cs |  |  |

## Lowered (19)

| Kind | Node type | Rule | Rationale | Fixture | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| AnonymousObjectCreationExpression | AnonymousObjectCreationExpressionSyntax | ADR-0115 §B.4 |  | tools/cs2gs/corpus/grid/G05-Collections-Console/Constructs/AnonymousObjectCreationExpression.cs | https://github.com/DavidObando/gsharp/issues/2538 | Lowers to positional construction of a shape-deduplicated synthesized data class, preserving named members and remaining a direct expression in constructor delegation (issues #2282 and #2538). |
| AnonymousObjectMemberDeclarator | AnonymousObjectMemberDeclaratorSyntax | ADR-0115 §B.4 |  | tools/cs2gs/corpus/grid/G05-Collections-Console/Constructs/AnonymousObjectCreationExpression.cs | https://github.com/DavidObando/gsharp/issues/2538 | Each declarator supplies one positional synthesized-data-class constructor argument; the synthesized declaration preserves the projected member names (issues #2282 and #2538). |
| AscendingOrdering | OrderingSyntax | ADR-0115 §B.21 |  | tools/cs2gs/corpus/grid/G11-Linq-Console/Constructs/OrderByClause.cs |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| DescendingOrdering | OrderingSyntax | ADR-0115 §B.21 |  | tools/cs2gs/corpus/grid/G11-Linq-Console/Constructs/OrderByClause.cs |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| ExplicitInterfaceSpecifier | ExplicitInterfaceSpecifierSyntax | ADR-0091 / ADR-0115 §B |  | tools/cs2gs/corpus/grid/G06-Types-Console/Constructs/ExplicitInterfaceSpecifier.cs |  | G# has no explicit-interface-implementation surface (ADR-0091 rejected an 'IFoo.M(this)' spelling); a lone explicit impl lowers to a plain public method (fixes the prior ilverify miss, issue #1911). An explicit impl coexisting with a same-signature public method is dropped in favor of the public method (disclosed semantic-loss diagnostic, not covered by this fixture's stdout parity); two explicit impls of different interfaces with no public sibling de-duplicate to one surviving public method with no semantic loss. |
| ForStatement | ForStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/ForStatement.cs |  | Lowered to a while loop when clauses demand it (issue #1732 incrementor-on-continue fix). |
| FromClause | FromClauseSyntax | ADR-0115 §B.21 |  | tools/cs2gs/corpus/grid/G11-Linq-Console/Constructs/FromClauseSelectMany.cs |  | First from lowers to the source receiver; a second/subsequent from lowers to SelectMany with a transparent-identifier tuple result selector (issue #1902). |
| GotoCaseStatement | GotoStatementSyntax | ADR-0139 |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/GotoCaseStatement.cs |  | Issue #1884: lowered to a plain `goto` targeting a synthesized label placed at the top of the matching case's translated body (no switch re-evaluation, so C# fall-through/evaluation order is preserved). |
| GotoDefaultStatement | GotoStatementSyntax | ADR-0139 |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/GotoDefaultStatement.cs |  | Issue #1884: lowered like `goto case` (see GotoCaseStatement), targeting a synthesized label at the top of the default section's translated body. |
| GroupClause | GroupClauseSyntax | ADR-0115 §B.21 |  | tools/cs2gs/corpus/grid/G11-Linq-Console/Constructs/GroupClause.cs |  | Query syntax lowered to the method-call chain, mirroring Roslyn (GroupBy, with identity-projection elision matching `select n`). |
| JoinClause | JoinClauseSyntax | ADR-0115 §B.21 |  | tools/cs2gs/corpus/grid/G11-Linq-Console/Constructs/JoinClause.cs |  | Query syntax lowered to the method-call chain, mirroring Roslyn (Join with a transparent-identifier tuple result selector). |
| JoinIntoClause | JoinIntoClauseSyntax | ADR-0115 §B.21 |  | tools/cs2gs/corpus/grid/G11-Linq-Console/Constructs/JoinIntoClause.cs |  | Query syntax lowered to the method-call chain, mirroring Roslyn (GroupJoin, with the `into` group variable typed `sequence[T]`). |
| LetClause | LetClauseSyntax | ADR-0115 §B.21 |  | tools/cs2gs/corpus/grid/G11-Linq-Console/Constructs/LetClause.cs |  | Query syntax lowered to the method-call chain, mirroring Roslyn (Select widening the scope tuple with the let-bound value). |
| OrderByClause | OrderByClauseSyntax | ADR-0115 §B.21 |  | tools/cs2gs/corpus/grid/G11-Linq-Console/Constructs/OrderByClause.cs |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| QueryBody | QueryBodySyntax | ADR-0115 §B.21 |  | tools/cs2gs/corpus/grid/G11-Linq-Console/Constructs/QueryExpression.cs |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| QueryContinuation | QueryContinuationSyntax | ADR-0115 §B.21 |  | tools/cs2gs/corpus/grid/G11-Linq-Console/Constructs/QueryContinuation.cs |  | Both select-into and group-into continuations re-scope the chain to the continuation variable (issue #1902). |
| QueryExpression | QueryExpressionSyntax | ADR-0115 §B.21 |  | tools/cs2gs/corpus/grid/G11-Linq-Console/Constructs/QueryExpression.cs |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| SelectClause | SelectClauseSyntax | ADR-0115 §B.21 |  | tools/cs2gs/corpus/grid/G11-Linq-Console/Constructs/QueryExpression.cs |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| WhereClause | WhereClauseSyntax | ADR-0115 §B.21 |  | tools/cs2gs/corpus/grid/G11-Linq-Console/Constructs/WhereClause.cs |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |

## UnsupportedByDesign (56)

| Kind | Node type | Rule | Rationale | Fixture | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ArgListExpression | LiteralExpressionSyntax |  | NoGsharpConstruct | tools/cs2gs/Cs2Gs.Tests/Fixtures/Grid/Unsupported/ArgListExpression.cs |  | Legacy TypedReference/varargs machinery (__makeref/__reftype/__refvalue/__arglist); no G# analog planned. |
| BadDirectiveTrivia | BadDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| ConversionOperatorMemberCref | ConversionOperatorMemberCrefSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| CrefBracketedParameterList | CrefBracketedParameterListSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| CrefParameter | CrefParameterSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| CrefParameterList | CrefParameterListSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| DefineDirectiveTrivia | DefineDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| ElifDirectiveTrivia | ElifDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| ElseDirectiveTrivia | ElseDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| EndIfDirectiveTrivia | EndIfDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| EndRegionDirectiveTrivia | EndRegionDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| ErrorDirectiveTrivia | ErrorDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| ExtensionMemberCref | ExtensionMemberCrefSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| ExternAliasDirective | ExternAliasDirectiveSyntax |  | NoGsharpConstruct |  |  | Extern aliases disambiguate identically-named assemblies — a project-system feature G# does not model. |
| IfDirectiveTrivia | IfDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| IgnoredDirectiveTrivia | IgnoredDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| IncompleteMember | IncompleteMemberSyntax |  | NotReachable |  |  | Parser error-recovery artifact; never appears in well-formed C#. |
| IndexerMemberCref | IndexerMemberCrefSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| LineDirectivePosition | LineDirectivePositionSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| LineDirectiveTrivia | LineDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| LineSpanDirectiveTrivia | LineSpanDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| LoadDirectiveTrivia | LoadDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| MakeRefExpression | MakeRefExpressionSyntax |  | NoGsharpConstruct | tools/cs2gs/Cs2Gs.Tests/Fixtures/Grid/Unsupported/MakeRefExpression.cs |  | Legacy TypedReference/varargs machinery (__makeref/__reftype/__refvalue/__arglist); no G# analog planned. |
| MultiLineDocumentationCommentTrivia | DocumentationCommentTriviaSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| NameMemberCref | NameMemberCrefSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| NullableDirectiveTrivia | NullableDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| OperatorMemberCref | OperatorMemberCrefSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| PragmaChecksumDirectiveTrivia | PragmaChecksumDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| PragmaWarningDirectiveTrivia | PragmaWarningDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| QualifiedCref | QualifiedCrefSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| RefTypeExpression | RefTypeExpressionSyntax |  | NoGsharpConstruct | tools/cs2gs/Cs2Gs.Tests/Fixtures/Grid/Unsupported/RefTypeExpression.cs |  | Legacy TypedReference/varargs machinery (__makeref/__reftype/__refvalue/__arglist); no G# analog planned. |
| RefValueExpression | RefValueExpressionSyntax |  | NoGsharpConstruct | tools/cs2gs/Cs2Gs.Tests/Fixtures/Grid/Unsupported/RefValueExpression.cs |  | Legacy TypedReference/varargs machinery (__makeref/__reftype/__refvalue/__arglist); no G# analog planned. |
| ReferenceDirectiveTrivia | ReferenceDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| RegionDirectiveTrivia | RegionDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| ShebangDirectiveTrivia | ShebangDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| SingleLineDocumentationCommentTrivia | DocumentationCommentTriviaSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| SkippedTokensTrivia | SkippedTokensTriviaSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| TypeCref | TypeCrefSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| UndefDirectiveTrivia | UndefDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| UnionDeclaration | (not exported by Roslyn 5.6) |  | NotReachable |  |  | Post-C#14 preview syntax in Roslyn 5.6; not reachable at LangVersion latest. |
| UnknownAccessorDeclaration | AccessorDeclarationSyntax |  | NotReachable |  |  | Parser error-recovery artifact; never appears in well-formed C#. |
| WarningDirectiveTrivia | WarningDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| WithElement | WithElementSyntax |  | NotReachable |  |  | Collection-expression with-element is preview-only (CS8652) under LangVersion latest (C# 14). |
| XmlCDataSection | XmlCDataSectionSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| XmlComment | XmlCommentSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| XmlCrefAttribute | XmlCrefAttributeSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| XmlElement | XmlElementSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| XmlElementEndTag | XmlElementEndTagSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| XmlElementStartTag | XmlElementStartTagSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| XmlEmptyElement | XmlEmptyElementSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| XmlName | XmlNameSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| XmlNameAttribute | XmlNameAttributeSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| XmlPrefix | XmlPrefixSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| XmlProcessingInstruction | XmlProcessingInstructionSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| XmlText | XmlTextSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| XmlTextAttribute | XmlTextAttributeSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |

## Gap (7)

| Kind | Node type | Rule | Rationale | Fixture | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ImplicitElementAccess | ImplicitElementAccessSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1897 |  |
| ImplicitStackAllocArrayCreationExpression | ImplicitStackAllocArrayCreationExpressionSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1897 | ADR-0124 stackalloc surface. |
| PointerMemberAccessExpression | MemberAccessExpressionSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1905 | p->X lowered to p.X; (*p).X compiles. |
| RangeExpression | RangeExpressionSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1896 | Lowers to .Slice(...) which gsc cannot resolve on arrays/strings. |
| RefExpression | RefExpressionSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1900 | ref argument/return seam (&x pass-by-address). |
| RefType | RefTypeSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1900 |  |
| SpreadElement | SpreadElementSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1897 |  |
