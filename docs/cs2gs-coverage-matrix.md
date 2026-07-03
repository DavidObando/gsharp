# cs2gs C# construct coverage matrix

Generated from `tools/cs2gs/coverage/csharp-construct-inventory.json` by `cs2gs coverage --write`.
Drift fails `ConstructInventoryGoldenTests`. Do not edit by hand.

| Status | Count |
| --- | --- |
| Unclassified | 43 |
| Translated | 211 |
| Lowered | 14 |
| UnsupportedByDesign | 53 |
| Gap | 0 |

## Unclassified (43)

| Kind | Node type | Rule | Rationale | Fixture | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| AddAccessorDeclaration | AccessorDeclarationSyntax |  |  |  |  |  |
| AllowsConstraintClause | AllowsConstraintClauseSyntax |  |  |  |  |  |
| AnonymousMethodExpression | AnonymousMethodExpressionSyntax |  |  |  |  |  |
| AnonymousObjectCreationExpression | AnonymousObjectCreationExpressionSyntax |  |  |  |  |  |
| AnonymousObjectMemberDeclarator | AnonymousObjectMemberDeclaratorSyntax |  |  |  |  |  |
| CatchFilterClause | CatchFilterClauseSyntax |  |  |  |  |  |
| CheckedExpression | CheckedExpressionSyntax |  |  |  |  |  |
| DefaultConstraint | DefaultConstraintSyntax |  |  |  |  |  |
| DestructorDeclaration | DestructorDeclarationSyntax |  |  |  |  |  |
| EventDeclaration | EventDeclarationSyntax |  |  |  |  |  |
| EventFieldDeclaration | EventFieldDeclarationSyntax |  |  |  |  |  |
| ExplicitInterfaceSpecifier | ExplicitInterfaceSpecifierSyntax |  |  |  |  |  |
| ExpressionColon | ExpressionColonSyntax |  |  |  |  |  |
| ExtensionBlockDeclaration | ExtensionBlockDeclarationSyntax |  |  |  |  |  |
| ExternAliasDirective | ExternAliasDirectiveSyntax |  |  |  |  |  |
| FieldExpression | FieldExpressionSyntax |  |  |  |  |  |
| FunctionPointerCallingConvention | FunctionPointerCallingConventionSyntax |  |  |  |  |  |
| FunctionPointerParameter | FunctionPointerParameterSyntax |  |  |  |  |  |
| FunctionPointerParameterList | FunctionPointerParameterListSyntax |  |  |  |  |  |
| FunctionPointerType | FunctionPointerTypeSyntax |  |  |  |  |  |
| FunctionPointerUnmanagedCallingConvention | FunctionPointerUnmanagedCallingConventionSyntax |  |  |  |  |  |
| FunctionPointerUnmanagedCallingConventionList | FunctionPointerUnmanagedCallingConventionListSyntax |  |  |  |  |  |
| GotoCaseStatement | GotoStatementSyntax |  |  |  |  |  |
| GotoDefaultStatement | GotoStatementSyntax |  |  |  |  |  |
| GotoStatement | GotoStatementSyntax |  |  |  |  |  |
| IncompleteMember | IncompleteMemberSyntax |  |  |  |  |  |
| LabeledStatement | LabeledStatementSyntax |  |  |  |  |  |
| OmittedArraySizeExpression | OmittedArraySizeExpressionSyntax |  |  |  |  |  |
| OmittedTypeArgument | OmittedTypeArgumentSyntax |  |  |  |  |  |
| PointerIndirectionExpression | PrefixUnaryExpressionSyntax |  |  |  |  |  |
| PointerMemberAccessExpression | MemberAccessExpressionSyntax |  |  |  |  |  |
| PointerType | PointerTypeSyntax |  |  |  |  |  |
| PositionalPatternClause | PositionalPatternClauseSyntax |  |  |  |  |  |
| PrimaryConstructorBaseType | PrimaryConstructorBaseTypeSyntax |  |  |  |  |  |
| RefStructConstraint | RefStructConstraintSyntax |  |  |  |  |  |
| RefType | RefTypeSyntax |  |  |  |  |  |
| RemoveAccessorDeclaration | AccessorDeclarationSyntax |  |  |  |  |  |
| ScopedType | ScopedTypeSyntax |  |  |  |  |  |
| UncheckedExpression | CheckedExpressionSyntax |  |  |  |  |  |
| UnsignedRightShiftAssignmentExpression | AssignmentExpressionSyntax |  |  |  |  |  |
| UnsignedRightShiftExpression | BinaryExpressionSyntax |  |  |  |  |  |
| Utf8StringLiteralExpression | LiteralExpressionSyntax |  |  |  |  |  |
| WithElement | WithElementSyntax |  |  |  |  |  |

## Translated (211)

| Kind | Node type | Rule | Rationale | Fixture | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| AccessorList | AccessorListSyntax | ADR-0115 §B.11 |  |  |  |  |
| AddAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  |  |  |  |
| AddExpression | BinaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| AddressOfExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B.30 |  |  |  |  |
| AliasQualifiedName | AliasQualifiedNameSyntax | ADR-0115 §B.12 |  |  |  |  |
| AndAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  |  |  |  |
| AndPattern | BinaryPatternSyntax | ADR-0115 §B.22 |  |  |  |  |
| Argument | ArgumentSyntax | ADR-0115 §B |  |  |  |  |
| ArgumentList | ArgumentListSyntax | ADR-0115 §B |  |  |  |  |
| ArrayCreationExpression | ArrayCreationExpressionSyntax | ADR-0115 §B.16 |  |  |  |  |
| ArrayInitializerExpression | InitializerExpressionSyntax | ADR-0115 §B.16 |  |  |  |  |
| ArrayRankSpecifier | ArrayRankSpecifierSyntax | ADR-0115 §B.16 |  |  |  |  |
| ArrayType | ArrayTypeSyntax | ADR-0115 §B.16 |  |  |  |  |
| ArrowExpressionClause | ArrowExpressionClauseSyntax | ADR-0115 §B.5 |  |  |  | Expression-bodied members (ADR-0131). |
| AsExpression | BinaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| Attribute | AttributeSyntax | ADR-0115 §B.11 |  |  |  |  |
| AttributeArgument | AttributeArgumentSyntax | ADR-0115 §B.11 |  |  |  |  |
| AttributeArgumentList | AttributeArgumentListSyntax | ADR-0115 §B.11 |  |  |  |  |
| AttributeList | AttributeListSyntax | ADR-0115 §B.11 |  |  |  |  |
| AttributeTargetSpecifier | AttributeTargetSpecifierSyntax | ADR-0115 §B.11 |  |  |  |  |
| AwaitExpression | AwaitExpressionSyntax | ADR-0115 §B.23 |  |  |  |  |
| BaseConstructorInitializer | ConstructorInitializerSyntax | ADR-0115 §B.28 |  |  |  |  |
| BaseExpression | BaseExpressionSyntax | ADR-0115 §B |  |  |  | base.M() virtual calls (issue #986, resolved). |
| BaseList | BaseListSyntax | ADR-0115 §B.6 |  |  |  |  |
| BitwiseAndExpression | BinaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| BitwiseNotExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| BitwiseOrExpression | BinaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| Block | BlockSyntax | ADR-0115 §B.2 |  |  |  |  |
| BracketedArgumentList | BracketedArgumentListSyntax | ADR-0115 §B |  |  |  | Issue #942 (resolved). |
| BracketedParameterList | BracketedParameterListSyntax | ADR-0115 §B.11 |  |  |  | User indexers (issue #944). |
| BreakStatement | BreakStatementSyntax | ADR-0115 §B |  |  |  |  |
| CasePatternSwitchLabel | CasePatternSwitchLabelSyntax | ADR-0115 §B.33 |  |  |  |  |
| CaseSwitchLabel | CaseSwitchLabelSyntax | ADR-0115 §B.33 |  |  |  |  |
| CastExpression | CastExpressionSyntax | ADR-0115 §B.17 |  |  |  |  |
| CatchClause | CatchClauseSyntax | ADR-0115 §B.27 |  |  |  |  |
| CatchDeclaration | CatchDeclarationSyntax | ADR-0115 §B.27 |  |  |  |  |
| CharacterLiteralExpression | LiteralExpressionSyntax | ADR-0115 §B |  |  |  |  |
| CheckedStatement | CheckedStatementSyntax | ADR-0115 §B |  |  |  | Emitted as a plain inner block; overflow-checking semantics are NOT preserved — candidate for reclassification. |
| ClassConstraint | ClassOrStructConstraintSyntax | ADR-0115 §B.7 |  |  |  |  |
| ClassDeclaration | ClassDeclarationSyntax | ADR-0115 §B.4 |  |  |  |  |
| CoalesceAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  |  |  |  |
| CoalesceExpression | BinaryExpressionSyntax | ADR-0115 §B |  |  |  | Binary ?? (issue #941, resolved). |
| CollectionExpression | CollectionExpressionSyntax | ADR-0115 §B.36 |  |  |  |  |
| CollectionInitializerExpression | InitializerExpressionSyntax | ADR-0115 §B.16 |  |  |  |  |
| CompilationUnit | CompilationUnitSyntax | ADR-0115 §B.1 |  |  |  |  |
| ComplexElementInitializerExpression | InitializerExpressionSyntax | ADR-0115 §B.16 |  |  |  |  |
| ConditionalAccessExpression | ConditionalAccessExpressionSyntax | ADR-0115 §B |  |  |  | Null-conditional ?. / ?[. |
| ConditionalExpression | ConditionalExpressionSyntax | ADR-0115 §B.26 |  |  |  |  |
| ConstantPattern | ConstantPatternSyntax | ADR-0115 §B.22 |  |  |  |  |
| ConstructorConstraint | ConstructorConstraintSyntax | ADR-0115 §B.7 |  |  |  |  |
| ConstructorDeclaration | ConstructorDeclarationSyntax | ADR-0115 §B.28 |  |  |  |  |
| ContinueStatement | ContinueStatementSyntax | ADR-0115 §B |  |  |  |  |
| ConversionOperatorDeclaration | ConversionOperatorDeclarationSyntax | ADR-0115 §B.31 |  |  |  |  |
| DeclarationExpression | DeclarationExpressionSyntax | ADR-0115 §B.30 |  |  |  |  |
| DeclarationPattern | DeclarationPatternSyntax | ADR-0115 §B.22 |  |  |  | x is T t binder (issue #993, resolved). |
| DefaultExpression | DefaultExpressionSyntax | ADR-0115 §B |  |  |  |  |
| DefaultLiteralExpression | LiteralExpressionSyntax | ADR-0115 §B |  |  |  |  |
| DefaultSwitchLabel | DefaultSwitchLabelSyntax | ADR-0115 §B.33 |  |  |  |  |
| DelegateDeclaration | DelegateDeclarationSyntax | ADR-0115 §B.8 |  |  |  |  |
| DiscardDesignation | DiscardDesignationSyntax | ADR-0115 §B.30 |  |  |  |  |
| DiscardPattern | DiscardPatternSyntax | ADR-0115 §B.22 |  |  |  |  |
| DivideAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  |  |  |  |
| DivideExpression | BinaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| DoStatement | DoStatementSyntax | ADR-0115 §B |  |  |  |  |
| ElementAccessExpression | ElementAccessExpressionSyntax | ADR-0115 §B |  |  |  | Issue #942 (resolved). |
| ElementBindingExpression | ElementBindingExpressionSyntax | ADR-0115 §B |  |  |  | Null-conditional ?. / ?[. |
| ElseClause | ElseClauseSyntax | ADR-0115 §B |  |  |  |  |
| EmptyStatement | EmptyStatementSyntax | ADR-0115 §B |  |  |  |  |
| EnumDeclaration | EnumDeclarationSyntax | ADR-0115 §B.11 |  |  |  |  |
| EnumMemberDeclaration | EnumMemberDeclarationSyntax | ADR-0115 §B.11 |  |  |  |  |
| EqualsExpression | BinaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| EqualsValueClause | EqualsValueClauseSyntax | ADR-0115 §B.3 |  |  |  |  |
| ExclusiveOrAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  |  |  |  |
| ExclusiveOrExpression | BinaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| ExpressionElement | ExpressionElementSyntax | ADR-0115 §B.36 |  |  |  |  |
| ExpressionStatement | ExpressionStatementSyntax | ADR-0115 §B |  |  |  |  |
| FalseLiteralExpression | LiteralExpressionSyntax | ADR-0115 §B |  |  |  |  |
| FieldDeclaration | FieldDeclarationSyntax | ADR-0115 §B.3 |  |  |  |  |
| FileScopedNamespaceDeclaration | FileScopedNamespaceDeclarationSyntax | ADR-0115 §B.1 |  |  |  |  |
| FinallyClause | FinallyClauseSyntax | ADR-0115 §B.27 |  |  |  |  |
| FixedStatement | FixedStatementSyntax | ADR-0115 §B |  |  |  |  |
| ForEachStatement | ForEachStatementSyntax | ADR-0115 §B |  |  |  |  |
| ForEachVariableStatement | ForEachVariableStatementSyntax | ADR-0115 §B |  |  |  |  |
| GenericName | GenericNameSyntax | ADR-0115 §B.7 |  |  |  |  |
| GetAccessorDeclaration | AccessorDeclarationSyntax | ADR-0115 §B.11 |  |  |  |  |
| GlobalStatement | GlobalStatementSyntax | ADR-0115 §B.11 |  |  |  | Entry-class hoisting (T3): top-level statements. |
| GreaterThanExpression | BinaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| GreaterThanOrEqualExpression | BinaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| IdentifierName | IdentifierNameSyntax | ADR-0115 §B.12 |  |  |  |  |
| IfStatement | IfStatementSyntax | ADR-0115 §B |  |  |  |  |
| ImplicitArrayCreationExpression | ImplicitArrayCreationExpressionSyntax | ADR-0115 §B.16 |  |  |  |  |
| ImplicitElementAccess | ImplicitElementAccessSyntax | ADR-0115 §B.16 |  |  |  |  |
| ImplicitObjectCreationExpression | ImplicitObjectCreationExpressionSyntax | ADR-0115 §B.25 |  |  |  |  |
| ImplicitStackAllocArrayCreationExpression | ImplicitStackAllocArrayCreationExpressionSyntax | ADR-0115 §B |  |  |  | ADR-0124 stackalloc surface. |
| IndexExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B.36 |  |  |  | ^i from-end index. |
| IndexerDeclaration | IndexerDeclarationSyntax | ADR-0115 §B.11 |  |  |  | User indexers (issue #944). |
| InitAccessorDeclaration | AccessorDeclarationSyntax | ADR-0115 §B.11 |  |  |  |  |
| InterfaceDeclaration | InterfaceDeclarationSyntax | ADR-0115 §B.4 |  |  |  |  |
| InterpolatedStringExpression | InterpolatedStringExpressionSyntax | ADR-0115 §B.9 |  |  |  |  |
| InterpolatedStringText | InterpolatedStringTextSyntax | ADR-0115 §B.9 |  |  |  |  |
| Interpolation | InterpolationSyntax | ADR-0115 §B.9 |  |  |  |  |
| InterpolationAlignmentClause | InterpolationAlignmentClauseSyntax | ADR-0115 §B.9 |  |  |  |  |
| InterpolationFormatClause | InterpolationFormatClauseSyntax | ADR-0115 §B.9 |  |  |  |  |
| InvocationExpression | InvocationExpressionSyntax | ADR-0115 §B |  |  |  |  |
| IsExpression | BinaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| IsPatternExpression | IsPatternExpressionSyntax | ADR-0115 §B.36 |  |  |  |  |
| LeftShiftAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  |  |  |  |
| LeftShiftExpression | BinaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| LessThanExpression | BinaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| LessThanOrEqualExpression | BinaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| ListPattern | ListPatternSyntax | ADR-0115 §B.22 |  |  |  |  |
| LocalDeclarationStatement | LocalDeclarationStatementSyntax | ADR-0115 §B.3 |  |  |  |  |
| LocalFunctionStatement | LocalFunctionStatementSyntax | ADR-0115 §B |  |  |  |  |
| LockStatement | LockStatementSyntax | ADR-0115 §B |  |  |  |  |
| LogicalAndExpression | BinaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| LogicalNotExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| LogicalOrExpression | BinaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| MemberBindingExpression | MemberBindingExpressionSyntax | ADR-0115 §B |  |  |  | Null-conditional ?. / ?[. |
| MethodDeclaration | MethodDeclarationSyntax | ADR-0115 §B.5 |  |  |  |  |
| ModuloAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  |  |  |  |
| ModuloExpression | BinaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| MultiplyAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  |  |  |  |
| MultiplyExpression | BinaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| NameColon | NameColonSyntax | ADR-0115 §B |  |  |  | Named arguments use the G# name: value form (ADR-0080). |
| NameEquals | NameEqualsSyntax | ADR-0115 §B.16 |  |  |  |  |
| NamespaceDeclaration | NamespaceDeclarationSyntax | ADR-0115 §B.1 |  |  |  |  |
| NotEqualsExpression | BinaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| NotPattern | UnaryPatternSyntax | ADR-0115 §B.22 |  |  |  |  |
| NullLiteralExpression | LiteralExpressionSyntax | ADR-0115 §B |  |  |  |  |
| NullableType | NullableTypeSyntax | ADR-0115 §B.12 |  |  |  | T? maps to G# nullable spelling. |
| NumericLiteralExpression | LiteralExpressionSyntax | ADR-0115 §B |  |  |  |  |
| ObjectCreationExpression | ObjectCreationExpressionSyntax | ADR-0115 §B.16 |  |  |  |  |
| ObjectInitializerExpression | InitializerExpressionSyntax | ADR-0115 §B.16 |  |  |  |  |
| OperatorDeclaration | OperatorDeclarationSyntax | ADR-0115 §B.31 |  |  |  |  |
| OrAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  |  |  |  |
| OrPattern | BinaryPatternSyntax | ADR-0115 §B.22 |  |  |  |  |
| Parameter | ParameterSyntax | ADR-0115 §B.5 |  |  |  |  |
| ParameterList | ParameterListSyntax | ADR-0115 §B.5 |  |  |  |  |
| ParenthesizedExpression | ParenthesizedExpressionSyntax | ADR-0115 §B |  |  |  |  |
| ParenthesizedLambdaExpression | ParenthesizedLambdaExpressionSyntax | ADR-0115 §B.20 |  |  |  |  |
| ParenthesizedPattern | ParenthesizedPatternSyntax | ADR-0115 §B.22 |  |  |  |  |
| ParenthesizedVariableDesignation | ParenthesizedVariableDesignationSyntax | ADR-0115 §B.30 |  |  |  |  |
| PostDecrementExpression | PostfixUnaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| PostIncrementExpression | PostfixUnaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| PreDecrementExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| PreIncrementExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| PredefinedType | PredefinedTypeSyntax | ADR-0115 §B.12 |  |  |  |  |
| PropertyDeclaration | PropertyDeclarationSyntax | ADR-0115 §B.11 |  |  |  |  |
| PropertyPatternClause | PropertyPatternClauseSyntax | ADR-0115 §B.22 |  |  |  | Property sub-patterns; designator collisions fixed in issue #1839. |
| QualifiedName | QualifiedNameSyntax | ADR-0115 §B.12 |  |  |  |  |
| RangeExpression | RangeExpressionSyntax | ADR-0115 §B.36 |  |  |  |  |
| RecordDeclaration | RecordDeclarationSyntax | ADR-0115 §B.4 |  |  |  |  |
| RecordStructDeclaration | RecordDeclarationSyntax | ADR-0115 §B.4 |  |  |  |  |
| RecursivePattern | RecursivePatternSyntax | ADR-0115 §B.22 |  |  |  | Property sub-patterns; designator collisions fixed in issue #1839. |
| RefExpression | RefExpressionSyntax | ADR-0115 §B.30 |  |  |  | ref argument/return seam (&x pass-by-address). |
| RelationalPattern | RelationalPatternSyntax | ADR-0115 §B.22 |  |  |  |  |
| ReturnStatement | ReturnStatementSyntax | ADR-0115 §B |  |  |  |  |
| RightShiftAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  |  |  |  |
| RightShiftExpression | BinaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| SetAccessorDeclaration | AccessorDeclarationSyntax | ADR-0115 §B.11 |  |  |  |  |
| SimpleAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  |  |  |  |
| SimpleBaseType | SimpleBaseTypeSyntax | ADR-0115 §B.6 |  |  |  |  |
| SimpleLambdaExpression | SimpleLambdaExpressionSyntax | ADR-0115 §B.20 |  |  |  |  |
| SimpleMemberAccessExpression | MemberAccessExpressionSyntax | ADR-0115 §B |  |  |  |  |
| SingleVariableDesignation | SingleVariableDesignationSyntax | ADR-0115 §B.30 |  |  |  |  |
| SizeOfExpression | SizeOfExpressionSyntax | ADR-0115 §B |  |  |  |  |
| SlicePattern | SlicePatternSyntax | ADR-0115 §B.22 |  |  |  |  |
| SpreadElement | SpreadElementSyntax | ADR-0115 §B.36 |  |  |  |  |
| StackAllocArrayCreationExpression | StackAllocArrayCreationExpressionSyntax | ADR-0115 §B |  |  |  | ADR-0124 stackalloc surface. |
| StringLiteralExpression | LiteralExpressionSyntax | ADR-0115 §B |  |  |  |  |
| StructConstraint | ClassOrStructConstraintSyntax | ADR-0115 §B.7 |  |  |  |  |
| StructDeclaration | StructDeclarationSyntax | ADR-0115 §B.4 |  |  |  |  |
| Subpattern | SubpatternSyntax | ADR-0115 §B.22 |  |  |  | Property sub-patterns; designator collisions fixed in issue #1839. |
| SubtractAssignmentExpression | AssignmentExpressionSyntax | ADR-0115 §B |  |  |  |  |
| SubtractExpression | BinaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| SuppressNullableWarningExpression | PostfixUnaryExpressionSyntax | ADR-0115 §B |  |  |  | x! maps to the G# !! assertion. |
| SwitchExpression | SwitchExpressionSyntax | ADR-0115 §B.22 |  |  |  |  |
| SwitchExpressionArm | SwitchExpressionArmSyntax | ADR-0115 §B.22 |  |  |  |  |
| SwitchSection | SwitchSectionSyntax | ADR-0115 §B.33 |  |  |  |  |
| SwitchStatement | SwitchStatementSyntax | ADR-0115 §B.33 |  |  |  |  |
| ThisConstructorInitializer | ConstructorInitializerSyntax | ADR-0115 §B.28 |  |  |  |  |
| ThisExpression | ThisExpressionSyntax | ADR-0115 §B |  |  |  |  |
| ThrowExpression | ThrowExpressionSyntax | ADR-0115 §B.27 |  |  |  |  |
| ThrowStatement | ThrowStatementSyntax | ADR-0115 §B.27 |  |  |  |  |
| TrueLiteralExpression | LiteralExpressionSyntax | ADR-0115 §B |  |  |  |  |
| TryStatement | TryStatementSyntax | ADR-0115 §B.27 |  |  |  |  |
| TupleElement | TupleElementSyntax | ADR-0115 §B.12 |  |  |  | G# tuple types (T1, T2). |
| TupleExpression | TupleExpressionSyntax | ADR-0115 §B |  |  |  |  |
| TupleType | TupleTypeSyntax | ADR-0115 §B.12 |  |  |  | G# tuple types (T1, T2). |
| TypeArgumentList | TypeArgumentListSyntax | ADR-0115 §B.7 |  |  |  |  |
| TypeConstraint | TypeConstraintSyntax | ADR-0115 §B.7 |  |  |  |  |
| TypeOfExpression | TypeOfExpressionSyntax | ADR-0115 §B |  |  |  |  |
| TypeParameter | TypeParameterSyntax | ADR-0115 §B.7 |  |  |  |  |
| TypeParameterConstraintClause | TypeParameterConstraintClauseSyntax | ADR-0115 §B.7 |  |  |  |  |
| TypeParameterList | TypeParameterListSyntax | ADR-0115 §B.7 |  |  |  |  |
| TypePattern | TypePatternSyntax | ADR-0115 §B.22 |  |  |  |  |
| UnaryMinusExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| UnaryPlusExpression | PrefixUnaryExpressionSyntax | ADR-0115 §B |  |  |  |  |
| UncheckedStatement | CheckedStatementSyntax | ADR-0115 §B |  |  |  | Emitted as a plain inner block; overflow-checking semantics are NOT preserved — candidate for reclassification. |
| UnsafeStatement | UnsafeStatementSyntax | ADR-0115 §B |  |  |  |  |
| UsingDirective | UsingDirectiveSyntax | ADR-0115 §B.1 |  |  |  |  |
| UsingStatement | UsingStatementSyntax | ADR-0115 §B.29 |  |  |  |  |
| VarPattern | VarPatternSyntax | ADR-0115 §B.22 |  |  |  |  |
| VariableDeclaration | VariableDeclarationSyntax | ADR-0115 §B.3 |  |  |  |  |
| VariableDeclarator | VariableDeclaratorSyntax | ADR-0115 §B.3 |  |  |  |  |
| WhenClause | WhenClauseSyntax | ADR-0115 §B.22 |  |  |  | Pattern guards (issue #991, resolved). |
| WhileStatement | WhileStatementSyntax | ADR-0115 §B |  |  |  |  |
| WithExpression | WithExpressionSyntax | ADR-0115 §B.15 |  |  |  |  |
| WithInitializerExpression | InitializerExpressionSyntax | ADR-0115 §B.15 |  |  |  |  |
| YieldBreakStatement | YieldStatementSyntax | ADR-0115 §B.34 |  |  |  | Issue #994 (resolved). |
| YieldReturnStatement | YieldStatementSyntax | ADR-0115 §B.34 |  |  |  |  |

## Lowered (14)

| Kind | Node type | Rule | Rationale | Fixture | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| AscendingOrdering | OrderingSyntax | ADR-0115 §B.21 |  |  |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| DescendingOrdering | OrderingSyntax | ADR-0115 §B.21 |  |  |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| ForStatement | ForStatementSyntax | ADR-0115 §B |  |  |  | Lowered to a while loop when clauses demand it (issue #1732 incrementor-on-continue fix). |
| FromClause | FromClauseSyntax | ADR-0115 §B.21 |  |  |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| GroupClause | GroupClauseSyntax | ADR-0115 §B.21 |  |  |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| JoinClause | JoinClauseSyntax | ADR-0115 §B.21 |  |  |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| JoinIntoClause | JoinIntoClauseSyntax | ADR-0115 §B.21 |  |  |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| LetClause | LetClauseSyntax | ADR-0115 §B.21 |  |  |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| OrderByClause | OrderByClauseSyntax | ADR-0115 §B.21 |  |  |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| QueryBody | QueryBodySyntax | ADR-0115 §B.21 |  |  |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| QueryContinuation | QueryContinuationSyntax | ADR-0115 §B.21 |  |  |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| QueryExpression | QueryExpressionSyntax | ADR-0115 §B.21 |  |  |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| SelectClause | SelectClauseSyntax | ADR-0115 §B.21 |  |  |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |
| WhereClause | WhereClauseSyntax | ADR-0115 §B.21 |  |  |  | Query syntax lowered to the method-call chain, mirroring Roslyn. |

## UnsupportedByDesign (53)

| Kind | Node type | Rule | Rationale | Fixture | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ArgListExpression | LiteralExpressionSyntax |  | NoGsharpConstruct |  |  | Legacy TypedReference/varargs machinery (__makeref/__reftype/__refvalue/__arglist); no G# analog planned. |
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
| IfDirectiveTrivia | IfDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| IgnoredDirectiveTrivia | IgnoredDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| IndexerMemberCref | IndexerMemberCrefSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| LineDirectivePosition | LineDirectivePositionSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| LineDirectiveTrivia | LineDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| LineSpanDirectiveTrivia | LineSpanDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| LoadDirectiveTrivia | LoadDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| MakeRefExpression | MakeRefExpressionSyntax |  | NoGsharpConstruct |  |  | Legacy TypedReference/varargs machinery (__makeref/__reftype/__refvalue/__arglist); no G# analog planned. |
| MultiLineDocumentationCommentTrivia | DocumentationCommentTriviaSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| NameMemberCref | NameMemberCrefSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| NullableDirectiveTrivia | NullableDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| OperatorMemberCref | OperatorMemberCrefSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| PragmaChecksumDirectiveTrivia | PragmaChecksumDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| PragmaWarningDirectiveTrivia | PragmaWarningDirectiveTriviaSyntax |  | Preprocessor |  |  | Resolved by Roslyn parse options before translation; inactive code is deliberately dropped. |
| QualifiedCref | QualifiedCrefSyntax |  | ToolingScope |  |  | Documentation/tooling structure, not program semantics; doc-comment mapping is ADR-0057 scope. |
| RefTypeExpression | RefTypeExpressionSyntax |  | NoGsharpConstruct |  |  | Legacy TypedReference/varargs machinery (__makeref/__reftype/__refvalue/__arglist); no G# analog planned. |
| RefValueExpression | RefValueExpressionSyntax |  | NoGsharpConstruct |  |  | Legacy TypedReference/varargs machinery (__makeref/__reftype/__refvalue/__arglist); no G# analog planned. |
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
