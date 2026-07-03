# cs2gs C# construct coverage matrix

Generated from `tools/cs2gs/coverage/csharp-construct-inventory.json` by `cs2gs coverage --write`.
Drift fails `ConstructInventoryGoldenTests`. Do not edit by hand.

| Status | Count |
| --- | --- |
| Unclassified | 0 |
| Translated | 209 |
| Lowered | 10 |
| UnsupportedByDesign | 56 |
| Gap | 46 |

## Translated (209)

| Kind | Node type | Rule | Rationale | Fixture | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| AccessorList | AccessorListSyntax | ADR-0115 §B.11 |  |  |  |  |
| AddAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/AddAssignmentExpression.cs |  |  |
| AddExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/AddExpression.cs |  |  |
| AddressOfExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B.30 |  |  |  |  |
| AliasQualifiedName | AliasQualifiedNameSyntax | ADR-0115 §B.12 |  |  |  |  |
| AllowsConstraintClause | AllowsConstraintClauseSyntax | ADR-0115 §B.7 |  | tools/cs2gs/corpus/grid/G08-Generics-Console/Constructs/AllowsConstraintClause.cs |  | C#13 allows ref struct passes E2E (grid G08). |
| AndAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/AndAssignmentExpression.cs |  |  |
| AndPattern | BinaryPatternSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/AndPattern.cs |  |  |
| Argument | ArgumentSyntax | ADR-0115 §B |  |  |  |  |
| ArgumentList | ArgumentListSyntax | ADR-0115 §B |  |  |  |  |
| ArrayCreationExpression | ArrayCreationExpressionSyntax | ADR-0115 §B.16 |  | tools/cs2gs/corpus/grid/G05-Collections-Console/Constructs/ArrayCreationExpression.cs | https://github.com/DavidObando/gsharp/issues/1893 | Multi-dim arrays silently lowered to 1-D (issue #1893, parity-verified); 1-D/jagged green. |
| ArrayInitializerExpression | InitializerExpressionSyntax | ADR-0115 §B.16 |  | tools/cs2gs/corpus/grid/G05-Collections-Console/Constructs/ArrayInitializerExpression.cs |  |  |
| ArrayRankSpecifier | ArrayRankSpecifierSyntax | ADR-0115 §B.16 |  |  |  |  |
| ArrayType | ArrayTypeSyntax | ADR-0115 §B.16 |  |  |  |  |
| ArrowExpressionClause | ArrowExpressionClauseSyntax | ADR-0115 §B.5 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/ArrowExpressionClause.cs |  | Expression-bodied members (ADR-0131). |
| AsExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/AsExpression.cs |  |  |
| Attribute | AttributeSyntax | ADR-0115 §B.11 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/AttributeList.cs |  | User-defined attribute classes blocked by gsc GS0200 (issue #1921). |
| AttributeArgument | AttributeArgumentSyntax | ADR-0115 §B.11 |  |  |  |  |
| AttributeArgumentList | AttributeArgumentListSyntax | ADR-0115 §B.11 |  |  |  |  |
| AttributeList | AttributeListSyntax | ADR-0115 §B.11 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/AttributeList.cs | https://github.com/DavidObando/gsharp/issues/1913 | BCL attributes green; parameter attributes silently dropped and generic attributes emit non-parsing G# (issue #1913). |
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
| CheckedStatement | CheckedStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/CheckedStatement.cs | https://github.com/DavidObando/gsharp/issues/1881 | Overflow semantics silently erased — emitted as a plain block (issue #1881, parity-verified divergence); non-overflow subset green. |
| ClassConstraint | ClassOrStructConstraintSyntax | ADR-0115 §B.7 |  | tools/cs2gs/corpus/grid/G08-Generics-Console/Constructs/ClassConstraint.cs |  |  |
| ClassDeclaration | ClassDeclarationSyntax | ADR-0115 §B.4 |  | tools/cs2gs/corpus/grid/G06-Types-Console/Constructs/ClassDeclaration.cs |  | C#12 primary ctors dropped (issue #1909); partial parts not merged (issue #1910). |
| CoalesceAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/CoalesceAssignmentExpression.cs | https://github.com/DavidObando/gsharp/issues/1916 | On nullable value types the emitted G# fails ilverify (gsc issue #1916); string form is green. |
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
| DefaultConstraint | DefaultConstraintSyntax | ADR-0115 §B.7 |  |  | https://github.com/DavidObando/gsharp/issues/1931 | Translates; gsc rejects default-constrained overrides (issue #1931). |
| DefaultExpression | DefaultExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/DefaultExpression.cs |  |  |
| DefaultLiteralExpression | LiteralExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G01-Literals-Console/Constructs/DefaultLiteralExpression.cs |  |  |
| DefaultSwitchLabel | DefaultSwitchLabelSyntax | ADR-0115 §B.33 |  |  |  |  |
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
| EnumDeclaration | EnumDeclarationSyntax | ADR-0115 §B.11 |  | tools/cs2gs/corpus/grid/G06-Types-Console/Constructs/EnumDeclaration.cs |  | Implicit member values only; explicit values/[Flags] silently erased (issue #1912). |
| EqualsExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/EqualsExpression.cs |  |  |
| EqualsValueClause | EqualsValueClauseSyntax | ADR-0115 §B.3 |  |  |  |  |
| ExclusiveOrAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/ExclusiveOrAssignmentExpression.cs |  |  |
| ExclusiveOrExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/ExclusiveOrExpression.cs |  |  |
| ExpressionColon | ExpressionColonSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/ExpressionColon.cs | https://github.com/DavidObando/gsharp/issues/1891 | is-form green; switch-expression arm form unsupported (issue #1891). |
| ExpressionElement | ExpressionElementSyntax | ADR-0115 §B.36 |  | tools/cs2gs/corpus/grid/G05-Collections-Console/Constructs/CollectionExpression.cs |  |  |
| ExpressionStatement | ExpressionStatementSyntax | ADR-0115 §B |  |  |  |  |
| FalseLiteralExpression | LiteralExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G01-Literals-Console/Constructs/FalseLiteralExpression.cs |  |  |
| FieldDeclaration | FieldDeclarationSyntax | ADR-0115 §B.3 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/FieldDeclaration.cs |  |  |
| FileScopedNamespaceDeclaration | FileScopedNamespaceDeclarationSyntax | ADR-0115 §B.1 |  |  |  |  |
| FinallyClause | FinallyClauseSyntax | ADR-0115 §B.27 |  |  |  |  |
| FixedStatement | FixedStatementSyntax | ADR-0115 §B |  |  | https://github.com/DavidObando/gsharp/issues/1933 | Compiles; ilverify-by-design (issue #1933). |
| ForEachStatement | ForEachStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/ForEachStatement.cs |  |  |
| ForEachVariableStatement | ForEachVariableStatementSyntax | ADR-0115 §B |  |  | https://github.com/DavidObando/gsharp/issues/1922 | Translates; blocked by gsc ValueTuple deconstruction (issue #1922). |
| GenericName | GenericNameSyntax | ADR-0115 §B.7 |  | tools/cs2gs/corpus/grid/G08-Generics-Console/Constructs/GenericName.cs |  |  |
| GetAccessorDeclaration | AccessorDeclarationSyntax | ADR-0115 §B.11 |  |  |  |  |
| GlobalStatement | GlobalStatementSyntax | ADR-0115 §B.11 |  |  |  | Entry-class hoisting (T3): top-level statements. |
| GreaterThanExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/GreaterThanExpression.cs |  |  |
| GreaterThanOrEqualExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/GreaterThanOrEqualExpression.cs |  |  |
| IdentifierName | IdentifierNameSyntax | ADR-0115 §B.12 |  |  |  |  |
| IfStatement | IfStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/IfStatement.cs |  |  |
| ImplicitArrayCreationExpression | ImplicitArrayCreationExpressionSyntax | ADR-0115 §B.16 |  | tools/cs2gs/corpus/grid/G05-Collections-Console/Constructs/ImplicitArrayCreationExpression.cs |  |  |
| ImplicitObjectCreationExpression | ImplicitObjectCreationExpressionSyntax | ADR-0115 §B.25 |  | tools/cs2gs/corpus/grid/G05-Collections-Console/Constructs/ObjectCreationExpression.cs |  |  |
| IndexExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B.36 |  | tools/cs2gs/corpus/grid/G05-Collections-Console/Constructs/IndexExpression.cs | https://github.com/DavidObando/gsharp/issues/1894 | Inline ^i green; Index-typed locals mis-lower (issue #1894, runtime crash). |
| IndexerDeclaration | IndexerDeclarationSyntax | ADR-0115 §B.11 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/IndexerDeclaration.cs |  | User indexers (issue #944). |
| InitAccessorDeclaration | AccessorDeclarationSyntax | ADR-0115 §B.11 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/PropertyDeclaration.cs | https://github.com/DavidObando/gsharp/issues/1892 | Blocked when targeted by object initializers (issue #1892). |
| InterfaceDeclaration | InterfaceDeclarationSyntax | ADR-0115 §B.4 |  | tools/cs2gs/corpus/grid/G06-Types-Console/Constructs/InterfaceDeclaration.cs |  |  |
| InterpolatedStringExpression | InterpolatedStringExpressionSyntax | ADR-0115 §B.9 |  | tools/cs2gs/corpus/grid/G14-Strings-Console/Constructs/InterpolatedStringExpression.cs |  |  |
| InterpolatedStringText | InterpolatedStringTextSyntax | ADR-0115 §B.9 |  | tools/cs2gs/corpus/grid/G14-Strings-Console/Constructs/InterpolatedStringText.cs | https://github.com/DavidObando/gsharp/issues/1882 | Brace escapes {{ }} copied verbatim — parity-verified divergence (issue #1882). |
| Interpolation | InterpolationSyntax | ADR-0115 §B.9 |  | tools/cs2gs/corpus/grid/G14-Strings-Console/Constructs/Interpolation.cs |  |  |
| InterpolationAlignmentClause | InterpolationAlignmentClauseSyntax | ADR-0115 §B.9 |  | tools/cs2gs/corpus/grid/G14-Strings-Console/Constructs/InterpolationAlignmentClause.cs |  |  |
| InterpolationFormatClause | InterpolationFormatClauseSyntax | ADR-0115 §B.9 |  | tools/cs2gs/corpus/grid/G14-Strings-Console/Constructs/InterpolationFormatClause.cs |  |  |
| InvocationExpression | InvocationExpressionSyntax | ADR-0115 §B |  |  |  |  |
| IsExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/IsExpression.cs |  |  |
| IsPatternExpression | IsPatternExpressionSyntax | ADR-0115 §B.36 |  |  |  |  |
| LeftShiftAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/LeftShiftAssignmentExpression.cs |  |  |
| LeftShiftExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/LeftShiftExpression.cs |  |  |
| LessThanExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/LessThanExpression.cs |  |  |
| LessThanOrEqualExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/LessThanOrEqualExpression.cs |  |  |
| LocalDeclarationStatement | LocalDeclarationStatementSyntax | ADR-0115 §B.3 |  |  |  |  |
| LocalFunctionStatement | LocalFunctionStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/LocalFunctionStatement.cs |  | Static local functions call through their `let` binding directly; generic local functions translate to G#'s `let Name[T, ...] = func (...) ... { ... }` (issue #1886, fixed). |
| LockStatement | LockStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/LockStatement.cs |  |  |
| LogicalAndExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/LogicalAndExpression.cs |  |  |
| LogicalNotExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/LogicalNotExpression.cs |  |  |
| LogicalOrExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/LogicalOrExpression.cs |  |  |
| MemberBindingExpression | MemberBindingExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/MemberBindingExpression.cs |  | Null-conditional ?. / ?[. |
| MethodDeclaration | MethodDeclarationSyntax | ADR-0115 §B.5 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/MethodDeclaration.cs |  |  |
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
| OmittedArraySizeExpression | OmittedArraySizeExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G05-Collections-Console/Constructs/OmittedArraySizeExpression.cs |  |  |
| OmittedTypeArgument | OmittedTypeArgumentSyntax | ADR-0115 §B.7 |  | tools/cs2gs/corpus/grid/G08-Generics-Console/Constructs/OmittedTypeArgument.cs | https://github.com/DavidObando/gsharp/issues/1915 | nameof(List<>) forms green (C#14); typeof(List<>) emits typeof(List) (issue #1915). |
| OperatorDeclaration | OperatorDeclarationSyntax | ADR-0115 §B.31 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/OperatorDeclaration.cs |  | C#14 instance compound-assignment operators fail round-trip (issue #1908); Equals(object) is-pattern override fails ilverify (issue #1917). |
| OrAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/OrAssignmentExpression.cs |  |  |
| OrPattern | BinaryPatternSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/OrPattern.cs |  |  |
| Parameter | ParameterSyntax | ADR-0115 §B.5 |  |  |  |  |
| ParameterList | ParameterListSyntax | ADR-0115 §B.5 |  |  |  |  |
| ParenthesizedExpression | ParenthesizedExpressionSyntax | ADR-0115 §B |  |  |  |  |
| ParenthesizedLambdaExpression | ParenthesizedLambdaExpressionSyntax | ADR-0115 §B.20 |  | tools/cs2gs/corpus/grid/G09-Functions-Console/Constructs/ParenthesizedLambdaExpression.cs | https://github.com/DavidObando/gsharp/issues/1901 | Lambda default parameters dropped (issue #1901); async lambdas blocked by gsc ICE (issue #1919). |
| ParenthesizedPattern | ParenthesizedPatternSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/ParenthesizedPattern.cs |  |  |
| ParenthesizedVariableDesignation | ParenthesizedVariableDesignationSyntax | ADR-0115 §B.30 |  |  |  |  |
| PointerIndirectionExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B |  |  | https://github.com/DavidObando/gsharp/issues/1925 | Compiles; ilverify-by-design (issue #1933). *(p + i) misbinds in gsc (issue #1925). |
| PointerType | PointerTypeSyntax | ADR-0115 §B |  |  | https://github.com/DavidObando/gsharp/issues/1933 | Pointer IL is unverifiable by design — pipeline policy issue #1933; compile-level green. |
| PostDecrementExpression | PostfixUnaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/PostDecrementExpression.cs |  |  |
| PostIncrementExpression | PostfixUnaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/PostIncrementExpression.cs |  |  |
| PreDecrementExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/PreDecrementExpression.cs |  |  |
| PreIncrementExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/PreIncrementExpression.cs |  |  |
| PredefinedType | PredefinedTypeSyntax | ADR-0115 §B.12 |  |  |  |  |
| PropertyDeclaration | PropertyDeclarationSyntax | ADR-0115 §B.11 |  | tools/cs2gs/corpus/grid/G07-Members-Console/Constructs/PropertyDeclaration.cs |  |  |
| PropertyPatternClause | PropertyPatternClauseSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/RecursivePattern.cs |  | Property sub-patterns; designator collisions fixed in issue #1839. |
| QualifiedName | QualifiedNameSyntax | ADR-0115 §B.12 |  |  |  |  |
| RecordDeclaration | RecordDeclarationSyntax | ADR-0115 §B.4 |  | tools/cs2gs/corpus/grid/G06-Types-Console/Constructs/RecordDeclaration.cs |  | with-expressions blocked by initializer bug (issue #1892). |
| RecordStructDeclaration | RecordDeclarationSyntax | ADR-0115 §B.4 |  | tools/cs2gs/corpus/grid/G06-Types-Console/Constructs/RecordStructDeclaration.cs |  |  |
| RecursivePattern | RecursivePatternSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/RecursivePattern.cs | https://github.com/DavidObando/gsharp/issues/1923 | Shallow property patterns green; nested reference-member and boxed/nullable subjects blocked by gsc (issue #1923). |
| RefStructConstraint | RefStructConstraintSyntax | ADR-0115 §B.7 |  | tools/cs2gs/corpus/grid/G08-Generics-Console/Constructs/AllowsConstraintClause.cs |  |  |
| RelationalPattern | RelationalPatternSyntax | ADR-0115 §B.22 |  | tools/cs2gs/corpus/grid/G04-Patterns-Console/Constructs/RelationalPattern.cs |  |  |
| ReturnStatement | ReturnStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/ReturnStatement.cs |  |  |
| RightShiftAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/RightShiftAssignmentExpression.cs |  |  |
| RightShiftExpression | BinaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/RightShiftExpression.cs |  |  |
| ScopedType | ScopedTypeSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G12-Unsafe-Console/Constructs/ScopedType.cs |  | scoped Span/scoped ref parameters translate and verify (grid G12). |
| SetAccessorDeclaration | AccessorDeclarationSyntax | ADR-0115 §B.11 |  |  |  |  |
| SimpleAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/SimpleAssignmentExpression.cs | https://github.com/DavidObando/gsharp/issues/1895 | Deconstruction-assignment into existing locals emits let bindings (issue #1895). |
| SimpleBaseType | SimpleBaseTypeSyntax | ADR-0115 §B.6 |  | tools/cs2gs/corpus/grid/G06-Types-Console/Constructs/SimpleBaseType.cs |  |  |
| SimpleLambdaExpression | SimpleLambdaExpressionSyntax | ADR-0115 §B.20 |  | tools/cs2gs/corpus/grid/G09-Functions-Console/Constructs/SimpleLambdaExpression.cs |  |  |
| SimpleMemberAccessExpression | MemberAccessExpressionSyntax | ADR-0115 §B |  |  |  |  |
| SingleVariableDesignation | SingleVariableDesignationSyntax | ADR-0115 §B.30 |  | tools/cs2gs/corpus/grid/G09-Functions-Console/Constructs/DeclarationExpression.cs |  |  |
| SizeOfExpression | SizeOfExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G12-Unsafe-Console/Constructs/SizeOfExpression.cs |  |  |
| StackAllocArrayCreationExpression | StackAllocArrayCreationExpressionSyntax | ADR-0115 §B |  |  | https://github.com/DavidObando/gsharp/issues/1933 | Translates and compiles; IL is unverifiable by design — pipeline policy issue #1933. |
| StringLiteralExpression | LiteralExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G01-Literals-Console/Constructs/StringLiteralExpression.cs |  |  |
| StructConstraint | ClassOrStructConstraintSyntax | ADR-0115 §B.7 |  | tools/cs2gs/corpus/grid/G08-Generics-Console/Constructs/StructConstraint.cs |  |  |
| StructDeclaration | StructDeclarationSyntax | ADR-0115 §B.4 |  | tools/cs2gs/corpus/grid/G06-Types-Console/Constructs/StructDeclaration.cs |  | Generic-struct ctor zip declined (issue #1915). |
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
| TypeParameter | TypeParameterSyntax | ADR-0115 §B.7 |  | tools/cs2gs/corpus/grid/G08-Generics-Console/Constructs/TypeParameterList.cs |  |  |
| TypeParameterConstraintClause | TypeParameterConstraintClauseSyntax | ADR-0115 §B.7 |  |  |  |  |
| TypeParameterList | TypeParameterListSyntax | ADR-0115 §B.7 |  | tools/cs2gs/corpus/grid/G08-Generics-Console/Constructs/TypeParameterList.cs |  | Generic class + primary ctor ICEs gsc (issue #1920); declaration-site variance missing in gsc (issue #1927). |
| UnaryMinusExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/UnaryMinusExpression.cs |  |  |
| UnaryPlusExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G02-Operators-Console/Constructs/UnaryPlusExpression.cs |  |  |
| UncheckedStatement | CheckedStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/UncheckedStatement.cs |  | Wrap-around parity verified (grid G03). |
| UnsafeStatement | UnsafeStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G12-Unsafe-Console/Constructs/UnsafeStatement.cs |  |  |
| UsingDirective | UsingDirectiveSyntax | ADR-0115 §B.1 |  | tools/cs2gs/corpus/grid/G06-Types-Console/Constructs/TypeAliasDeclaration.cs | https://github.com/DavidObando/gsharp/issues/1914 | Plain + simple-alias green; alias-any-type (C#12) unsupported (issue #1914). |
| UsingStatement | UsingStatementSyntax | ADR-0115 §B.29 |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/UsingStatement.cs | https://github.com/DavidObando/gsharp/issues/1903 | await using drops async-dispose semantics (issue #1903). |
| Utf8StringLiteralExpression | LiteralExpressionSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G01-Literals-Console/Constructs/Utf8StringLiteralExpression.cs |  | C# 11 u8 literals translate and reach parity (grid G01). |
| VariableDeclaration | VariableDeclarationSyntax | ADR-0115 §B.3 |  |  |  |  |
| VariableDeclarator | VariableDeclaratorSyntax | ADR-0115 §B.3 |  |  |  |  |
| WhenClause | WhenClauseSyntax | ADR-0115 §B.22 |  |  |  | Pattern guards (issue #991, resolved). |
| WhileStatement | WhileStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/WhileStatement.cs |  |  |
| YieldBreakStatement | YieldStatementSyntax | ADR-0115 §B.34 |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/YieldBreakStatement.cs |  | Issue #994 (resolved). |
| YieldReturnStatement | YieldStatementSyntax | ADR-0115 §B.34 |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/YieldReturnStatement.cs |  |  |

## Lowered (10)

| Kind | Node type | Rule | Rationale | Fixture | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| AscendingOrdering | OrderingSyntax | ADR-0115 §B.21 |  | tools/cs2gs/corpus/grid/G11-Linq-Console/Constructs/OrderByClause.cs |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| DescendingOrdering | OrderingSyntax | ADR-0115 §B.21 |  | tools/cs2gs/corpus/grid/G11-Linq-Console/Constructs/OrderByClause.cs |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| ForStatement | ForStatementSyntax | ADR-0115 §B |  | tools/cs2gs/corpus/grid/G03-ControlFlow-Console/Constructs/ForStatement.cs |  | Lowered to a while loop when clauses demand it (issue #1732 incrementor-on-continue fix). |
| FromClause | FromClauseSyntax | ADR-0115 §B.21 |  | tools/cs2gs/corpus/grid/G11-Linq-Console/Constructs/QueryExpression.cs | https://github.com/DavidObando/gsharp/issues/1902 | First from lowers; a second from (SelectMany) has no lowering (issue #1902). |
| OrderByClause | OrderByClauseSyntax | ADR-0115 §B.21 |  | tools/cs2gs/corpus/grid/G11-Linq-Console/Constructs/OrderByClause.cs |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| QueryBody | QueryBodySyntax | ADR-0115 §B.21 |  | tools/cs2gs/corpus/grid/G11-Linq-Console/Constructs/QueryExpression.cs |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| QueryContinuation | QueryContinuationSyntax | ADR-0115 §B.21 |  | tools/cs2gs/corpus/grid/G11-Linq-Console/Constructs/QueryContinuation.cs |  | Non-group into green; group-based continuation blocked by GroupClause (issue #1902). |
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

## Gap (46)

| Kind | Node type | Rule | Rationale | Fixture | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| AddAccessorDeclaration | AccessorDeclarationSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1899 |  |
| AnonymousMethodExpression | AnonymousMethodExpressionSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1898 |  |
| AnonymousObjectCreationExpression | AnonymousObjectCreationExpressionSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1934 |  |
| AnonymousObjectMemberDeclarator | AnonymousObjectMemberDeclaratorSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1934 |  |
| CheckedExpression | CheckedExpressionSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1881 |  |
| DelegateDeclaration | DelegateDeclarationSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1899 |  |
| EnumMemberDeclaration | EnumMemberDeclarationSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1912 | Explicit values, [Flags], negative and alias members erased to sequential ordinals — parity-verified divergence. |
| EventDeclaration | EventDeclarationSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1899 |  |
| EventFieldDeclaration | EventFieldDeclarationSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1899 |  |
| ExplicitInterfaceSpecifier | ExplicitInterfaceSpecifierSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1911 |  |
| ExtensionBlockDeclaration | ExtensionBlockDeclarationSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1879 | C# 14 headline; classic this-param extensions map to receiver funcs and are green (grid G13). |
| FieldExpression | FieldExpressionSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1907 | C# 14 field keyword. |
| FunctionPointerCallingConvention | FunctionPointerCallingConventionSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1906 |  |
| FunctionPointerParameter | FunctionPointerParameterSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1906 |  |
| FunctionPointerParameterList | FunctionPointerParameterListSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1906 |  |
| FunctionPointerType | FunctionPointerTypeSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1906 |  |
| FunctionPointerUnmanagedCallingConvention | FunctionPointerUnmanagedCallingConventionSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1906 |  |
| FunctionPointerUnmanagedCallingConventionList | FunctionPointerUnmanagedCallingConventionListSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1906 |  |
| GotoCaseStatement | GotoStatementSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1884 |  |
| GotoDefaultStatement | GotoStatementSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1884 |  |
| GotoStatement | GotoStatementSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1884 |  |
| GroupClause | GroupClauseSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1902 | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| ImplicitElementAccess | ImplicitElementAccessSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1897 |  |
| ImplicitStackAllocArrayCreationExpression | ImplicitStackAllocArrayCreationExpressionSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1897 | ADR-0124 stackalloc surface. |
| JoinClause | JoinClauseSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1902 | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| JoinIntoClause | JoinIntoClauseSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1902 | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| LabeledStatement | LabeledStatementSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1884 |  |
| LetClause | LetClauseSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1902 | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| ListPattern | ListPatternSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1889 |  |
| ObjectInitializerExpression | InitializerExpressionSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1892 | Initializer assignments emitted as stray statements. |
| PointerMemberAccessExpression | MemberAccessExpressionSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1905 | p->X lowered to p.X; (*p).X compiles. |
| PositionalPatternClause | PositionalPatternClauseSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1887 | SILENT MISTRANSLATION: sub-patterns dropped to match-anything case { }. |
| PrimaryConstructorBaseType | PrimaryConstructorBaseTypeSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1909 |  |
| RangeExpression | RangeExpressionSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1896 | Lowers to .Slice(...) which gsc cannot resolve on arrays/strings. |
| RefExpression | RefExpressionSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1900 | ref argument/return seam (&x pass-by-address). |
| RefType | RefTypeSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1900 |  |
| RemoveAccessorDeclaration | AccessorDeclarationSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1899 |  |
| SlicePattern | SlicePatternSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1889 |  |
| SpreadElement | SpreadElementSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1897 |  |
| TypePattern | TypePatternSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1890 | Bare-type switch-expression arms; is/case binder forms work (DeclarationPattern). |
| UncheckedExpression | CheckedExpressionSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1881 |  |
| UnsignedRightShiftAssignmentExpression | AssignmentExpressionSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1880 | Emits >>>= verbatim; never parses. |
| UnsignedRightShiftExpression | BinaryExpressionSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1880 | Translator crash: Unknown binary operator >>>. |
| VarPattern | VarPatternSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1888 |  |
| WithExpression | WithExpressionSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1892 | Stray bare assignment emitted before the with-expression. |
| WithInitializerExpression | InitializerExpressionSyntax |  |  |  | https://github.com/DavidObando/gsharp/issues/1892 |  |
