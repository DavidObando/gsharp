// <copyright file="GNodeSamples.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests.Coverage

import Cs2Gs.CodeModel.Ast
import System
import System.Collections.Generic
import System.Linq
import System.Runtime.InteropServices

/// Registry mapping every concrete (cref:GNode) subclass to a factory
/// producing a minimal (cref:CompilationUnit) that exercises that node
/// through the canonical printer and the real G# parser.
/// (cref:PrinterExhaustivenessTests) asserts the registry stays total
/// as the code model grows: when a new node type is added, add printer
/// coverage and a tiny sample here.
shared class GNodeSamples {
    internal func IsConcreteNodeType(type Type) bool -> type.IsClass && typeof(GNode).IsAssignableFrom(type) &&
        type.IsSealed

    /// Gets, for every concrete (cref:GNode) subclass, a factory
    /// building a minimal compilation unit exercising that node type.
    private let _all IReadOnlyDictionary[Type, () -> CompilationUnit] = Build()

    prop All IReadOnlyDictionary[Type, () -> CompilationUnit] {
        get {
            return _all
        }
    }

    private func Build() IReadOnlyDictionary[Type, () -> CompilationUnit] -> Dictionary[Type, () -> CompilationUnit]{
        [typeof(CompilationUnit)] = () -> Unit(MethodDeclaration("Run", body: Block())),
        [typeof(ImportDirective)] = () -> CompilationUnit("Demo", GNodeSamples.List(ImportDirective("System"))),
        [typeof(Parameter)] = () -> Unit(
            MethodDeclaration(
                "Echo",
                parameters: GNodeSamples.List(Parameter("n", GNodeSamples.Type("int32"))),
                returnType: GNodeSamples.Type("int32"),
                body: Block(ReturnStatement(Id("n")))
            )
        ),
        [typeof(TypeParameter)] = () -> Unit(
            MethodDeclaration(
                "First",
                parameters: GNodeSamples.List(Parameter("v", GNodeSamples.Type("T"))),
                returnType: GNodeSamples.Type("T"),
                typeParameters: GNodeSamples.List(TypeParameter("T", "any")),
                body: Block(ReturnStatement(Id("v")))
            )
        ),
        [typeof(AttributeArgument)] = AttributeSample,
        [typeof(AttributeUse)] = AttributeSample,
        [typeof(Receiver)] = () -> Unit(
            MethodDeclaration(
                "Doubled",
                returnType: GNodeSamples.Type("int32"),
                receiver: Receiver("v", GNodeSamples.Type("int32")),
                body: Block(ReturnStatement(BinaryExpression(Id("v"), "*", Int("2"))))
            )
        ),
        [typeof(BlockExpression)] = () -> Expr(
            BlockExpression(
                List[GStatement](LocalDeclarationStatement(BindingKind.Let, "y", initializer: Int("1"))),
                Id("y")
            )
        ),
        [typeof(LiteralExpression)] = () -> Expr(Int("42")),
        [typeof(IdentifierExpression)] = () -> Expr(Id("y")),
        [typeof(ThisExpression)] = () -> Unit(
            TypeDeclaration(
                TypeDeclarationKind.Class,
                "C",
                members: Members(
                    MethodDeclaration(
                        "Self",
                        returnType: GNodeSamples.Type("C"),
                        body: Block(ReturnStatement(ThisExpression()))
                    )
                )
            )
        ),
        [typeof(MemberAccessExpression)] = () -> Expr(MemberAccessExpression(Id("a"), "B")),
        [typeof(InvocationExpression)] = () -> Expr(InvocationExpression(Id("f"), List[GExpression](Id("v")))),
        [typeof(ManagedReferenceExpression)] = () -> Expr(ManagedReferenceExpression(Id("v"), isReadOnly: true)),
        [typeof(NamedArgumentExpression)] = () -> Expr(
            InvocationExpression(Id("f"), List[GExpression](NamedArgumentExpression("value", Int("1"))))
        ),
        [typeof(IndexExpression)] = () -> Expr(IndexExpression(Id("a"), Int("0"))),
        [typeof(FromEndIndexExpression)] = () -> Expr(IndexExpression(Id("a"), FromEndIndexExpression(Int("1")))),
        [typeof(RangeIndexExpression)] = () -> Expr(
            IndexExpression(Id("a"), RangeIndexExpression(Int("1"), FromEndIndexExpression(Int("1"))))
        ),
        [typeof(FieldInitializer)] = CompositeLiteralSample,
        [typeof(CompositeLiteralExpression)] = CompositeLiteralSample,
        [typeof(ObjectCreationInitializerExpression)] = () -> Expr(
            ObjectCreationInitializerExpression(
                InvocationExpression(Id("Foo"), List[GExpression](Int("1"))),
                GNodeSamples.List(FieldInitializer("Bar", Int("2")))
            )
        ),
        [typeof(AnonymousClassMemberInitializer)] = () -> Expr(
            AnonymousClassLiteralExpression(
                GNodeSamples.List(AnonymousClassMemberInitializer("Bar", GNodeSamples.Type("int32"), Int("2")))
            )
        ),
        [typeof(AnonymousClassLiteralExpression)] = () -> Expr(
            AnonymousClassLiteralExpression(
                GNodeSamples.List(AnonymousClassMemberInitializer("Bar", GNodeSamples.Type("int32"), Int("2")))
            )
        ),
        [typeof(CollectionInitializerElement)] = CollectionInitializerSample,
        [typeof(CollectionInitializerExpression)] = CollectionInitializerSample,
        [typeof(SpreadElementExpression)] = () -> Expr(
            ArrayLiteralExpression(GNodeSamples.Type("int32"), List[GExpression](SpreadElementExpression(Id("items"))))
        ),
        [typeof(ArrayLiteralExpression)] = () -> Expr(
            ArrayLiteralExpression(GNodeSamples.Type("int32"), List[GExpression](Int("1"), Int("2")))
        ),
        [typeof(ArrayAllocationExpression)] = () -> Expr(
            ArrayAllocationExpression(GNodeSamples.Type("int32"), Int("3"))
        ),
        [typeof(ConversionExpression)] = () -> Expr(ConversionExpression(GNodeSamples.Type("int32"), Id("y"))),
        [typeof(WithExpression)] = () -> Expr(
            WithExpression(Id("p"), GNodeSamples.List(FieldInitializer("X", Int("2"))))
        ),
        [typeof(TupleLiteralExpression)] = () -> Expr(TupleLiteralExpression(List[GExpression](Int("1"), Int("2")))),
        [typeof(BinaryExpression)] = () -> Expr(BinaryExpression(Int("1"), "+", Int("2"))),
        [typeof(UnaryExpression)] = () -> Expr(UnaryExpression("-", Id("y"))),
        [typeof(NonNullAssertionExpression)] = () -> Expr(NonNullAssertionExpression(Id("y"))),
        [typeof(IncrementDecrementExpression)] = () -> Expr(
            IncrementDecrementExpression(Id("i"), "++", isPrefix: false)
        ),
        [typeof(StackAllocExpression)] = () -> Stmts(
            BlockStatement(
                List[GStatement](
                    LocalDeclarationStatement(
                        BindingKind.Let,
                        "x",
                        initializer: StackAllocExpression(GNodeSamples.Type("uint8"), Int("4"))
                    )
                ),
                isUnsafe: true
            )
        ),
        [typeof(ParenthesizedExpression)] = () -> Expr(ParenthesizedExpression(Int("1"))),
        [typeof(AssignmentExpression)] = () -> Expr(AssignmentExpression(Id("x"), Int("1"))),
        [typeof(PatternTestExpression)] = () -> Expr(PatternTestExpression(Id("x"), ConstantPattern(Int("1")))),
        [typeof(CheckedExpression)] = () -> Expr(
            CheckedExpression(BinaryExpression(Int("1"), "+", Int("2")), isChecked: true)
        ),
        [typeof(LambdaExpression)] = () -> Expr(
            LambdaExpression(GNodeSamples.List(Parameter("n", GNodeSamples.Type("int32"))), expressionBody: Id("n"))
        ),
        [typeof(AwaitExpression)] = () -> Unit(
            MethodDeclaration(
                "RunAsync",
                returnType: GNodeSamples.Type("int32"),
                body: Block(ReturnStatement(AwaitExpression(InvocationExpression(Id("f"))))),
                isAsync: true
            )
        ),
        [typeof(SwitchArm)] = SwitchExpressionSample,
        [typeof(SwitchExpression)] = SwitchExpressionSample,
        [typeof(InterpolationPart)] = InterpolatedStringSample,
        [typeof(InterpolatedStringExpression)] = InterpolatedStringSample,
        [typeof(IfExpression)] = () -> Expr(IfExpression(Id("c"), Int("1"), Int("2"))),
        [typeof(IfLetBinding)] = IfLetExpressionSample,
        [typeof(IfLetExpression)] = IfLetExpressionSample,
        [typeof(OutArgumentExpression)] = () -> Stmts(
            ExpressionStatement(InvocationExpression(Id("M"), List[GExpression](OutArgumentExpression("out var", "x"))))
        ),
        [typeof(TypeOfExpression)] = () -> Expr(TypeOfExpression(GNodeSamples.Type("string"))),
        [typeof(DefaultValueExpression)] = () -> Expr(DefaultValueExpression(GNodeSamples.Type("int32"))),
        [typeof(TypeExpression)] = () -> Expr(
            BinaryExpression(Id("o"), "as", TypeExpression(GNodeSamples.Type("string")))
        ),
        [typeof(ConditionalReceiverExpression)] = ConditionalAccessSample,
        [typeof(ConditionalAccessExpression)] = ConditionalAccessSample,
        [typeof(ThrowExpression)] = () -> Expr(
            BinaryExpression(
                Id("y"),
                "??",
                ThrowExpression(
                    InvocationExpression(Id("Exception"), List[GExpression](LiteralExpression.String("boom"))),
                    nil
                )
            )
        ),
        [typeof(BlockStatement)] = () -> Stmts(),
        [typeof(LocalDeclarationStatement)] = () -> Stmts(
            LocalDeclarationStatement(BindingKind.Var, "n", GNodeSamples.Type("int32"), Int("0"))
        ),
        [typeof(ExpressionStatement)] = () -> Stmts(ExpressionStatement(InvocationExpression(Id("f")))),
        [typeof(AssignmentStatement)] = () -> Stmts(AssignmentStatement(Id("x"), Int("1"))),
        [typeof(MultiAssignmentStatement)] = () -> Stmts(
            MultiAssignmentStatement([]GExpression{Id("a"), Id("b")}, []GExpression{Id("b"), Id("a")})
        ),
        [typeof(IfLetStatement)] = () -> Stmts(
            IfLetStatement(
                []IfLetBinding{IfLetBinding("v", Id("maybe"))},
                BlockStatement([]GStatement{ExpressionStatement(Id("v"))})
            )
        ),
        [typeof(ReturnStatement)] = () -> Unit(
            MethodDeclaration("One", returnType: GNodeSamples.Type("int32"), body: Block(ReturnStatement(Int("1"))))
        ),
        [typeof(IfStatement)] = () -> Stmts(IfStatement(Id("c"), Block(), Block())),
        [typeof(WhileStatement)] = () -> Stmts(WhileStatement(Id("c"), Block())),
        [typeof(WhileLetStatement)] = () -> Stmts(
            WhileLetStatement(
                []IfLetBinding{IfLetBinding("v", Id("maybe"))},
                BlockStatement([]GStatement{ExpressionStatement(Id("v"))})
            )
        ),
        [typeof(LockStatement)] = () -> Stmts(LockStatement(Id("gate"), Block())),
        [typeof(ForStatement)] = () -> Stmts(
            ForStatement(
                LocalDeclarationStatement(BindingKind.Var, "i", initializer: Int("0")),
                BinaryExpression(Id("i"), "<", Int("3")),
                IncrementDecrementStatement(Id("i"), "++"),
                Block()
            )
        ),
        [typeof(IncrementDecrementStatement)] = () -> Stmts(
            LocalDeclarationStatement(BindingKind.Var, "i", initializer: Int("0")),
            IncrementDecrementStatement(Id("i"), "++")
        ),
        [typeof(ForInStatement)] = () -> Stmts(ForInStatement("item", Id("items"), Block())),
        [typeof(ForTupleInStatement)] = () -> Stmts(ForTupleInStatement([]string{"a", "b"}, Id("items"), Block())),
        [typeof(ThrowStatement)] = () -> Stmts(
            ThrowStatement(InvocationExpression(Id("Exception"), List[GExpression](LiteralExpression.String("boom"))))
        ),
        [typeof(RethrowStatement)] = () -> Stmts(
            TryStatement(
                Block(),
                GNodeSamples.List(CatchClause("e", GNodeSamples.Type("Exception"), Block(RethrowStatement()))),
                finallyBlock: nil
            )
        ),
        [typeof(DeferStatement)] = () -> Stmts(DeferStatement(InvocationExpression(Id("cleanup")))),
        [typeof(RawStatement)] = () -> Stmts(RawStatement("let raw = 1")),
        [typeof(CatchClause)] = TrySample,
        [typeof(TryStatement)] = TrySample,
        [typeof(SwitchStatementCase)] = SwitchStatementSample,
        [typeof(SwitchStatement)] = SwitchStatementSample,
        [typeof(YieldStatement)] = () -> Unit(
            MethodDeclaration(
                "Numbers",
                returnType: NamedTypeReference("sequence", List[GTypeReference](GNodeSamples.Type("int32"))),
                body: Block(YieldStatement(Int("1")))
            )
        ),
        [typeof(BreakStatement)] = () -> Stmts(WhileStatement(Id("c"), Block(BreakStatement()))),
        [typeof(ContinueStatement)] = () -> Stmts(WhileStatement(Id("c"), Block(ContinueStatement()))),
        [typeof(FallthroughStatement)] = () -> Stmts(
            SwitchStatement(
                Id("v"),
                GNodeSamples.List(
                    SwitchStatementCase(ConstantPattern(Int("0")), Block(FallthroughStatement())),
                    SwitchStatementCase(nil, Block())
                )
            )
        ),
        [typeof(GotoStatement)] = () -> Stmts(GotoStatement("retry")),
        [typeof(LabeledStatement)] = () -> Stmts(LabeledStatement("retry", GotoStatement("retry"))),
        [typeof(DoWhileStatement)] = () -> Stmts(DoWhileStatement(Block(), Id("c"))),
        [typeof(TupleDeconstructionStatement)] = () -> Stmts(
            TupleDeconstructionStatement(BindingKind.Let, GNodeSamples.List("a", "b"), Id("t"))
        ),
        [typeof(LocalFunctionStatement)] = () -> Stmts(
            LocalFunctionStatement(
                "helper",
                LambdaExpression(
                    List[Parameter](),
                    blockBody: Block(ReturnStatement(Int("1"))),
                    returnType: GNodeSamples.Type("int32"),
                    isFunctionLiteral: true
                )
            )
        ),
        [typeof(FixedStatement)] = () -> Stmts(
            BlockStatement(
                List[GStatement](
                    FixedStatement("p", PointerTypeReference(GNodeSamples.Type("uint8")), Id("buffer"), Block())
                ),
                isUnsafe: true
            )
        ),
        [typeof(FieldDeclaration)] = () -> Unit(FieldDeclaration(BindingKind.Var, "count", GNodeSamples.Type("int32"))),
        [typeof(PropertyAccessor)] = PropertySample,
        [typeof(PropertyDeclaration)] = PropertySample,
        [typeof(MethodDeclaration)] = () -> Unit(MethodDeclaration("Run", body: Block())),
        [typeof(ConstructorDeclaration)] = () -> Unit(
            TypeDeclaration(
                TypeDeclarationKind.Class,
                "C",
                members: Members(
                    ConstructorDeclaration(GNodeSamples.List(Parameter("n", GNodeSamples.Type("int32"))), Block())
                )
            )
        ),
        [typeof(SharedBlock)] = () -> Unit(
            TypeDeclaration(
                TypeDeclarationKind.Class,
                "C",
                members: Members(
                    SharedBlock(
                        Members(
                            MethodDeclaration(
                                "Zero",
                                returnType: GNodeSamples.Type("int32"),
                                body: Block(ReturnStatement(Int("0")))
                            )
                        )
                    )
                )
            )
        ),
        [typeof(DestructorDeclaration)] = () -> Unit(
            TypeDeclaration(TypeDeclarationKind.Class, "C", members: Members(DestructorDeclaration(Block())))
        ),
        [typeof(StaticInitializerBlock)] = () -> Unit(
            TypeDeclaration(
                TypeDeclarationKind.Class,
                "C",
                members: Members(SharedBlock(Members(StaticInitializerBlock(Block()))))
            )
        ),
        [typeof(EventDeclaration)] = () -> Unit(
            TypeDeclaration(
                TypeDeclarationKind.Class,
                "C",
                members: Members(EventDeclaration("Changed", GNodeSamples.Type("EventHandler")))
            )
        ),
        [typeof(TypeDeclaration)] = () -> Unit(TypeDeclaration(TypeDeclarationKind.Class, "C")),
        [typeof(EnumCase)] = EnumSample,
        [typeof(EnumDeclaration)] = EnumSample,
        [typeof(NamedDelegateDeclaration)] = () -> Unit(
            NamedDelegateDeclaration(
                "Combine",
                GNodeSamples.List(Parameter("a", GNodeSamples.Type("int32"))),
                GNodeSamples.Type("int32")
            )
        ),
        [typeof(ConstantPattern)] = () -> Pattern(ConstantPattern(Int("0"))),
        [typeof(RelationalPattern)] = () -> Pattern(RelationalPattern("<", Int("10"))),
        [typeof(TypePattern)] = () -> Pattern(TypePattern("s", GNodeSamples.Type("string"))),
        [typeof(PropertyPatternField)] = PropertyPatternSample,
        [typeof(PropertyPattern)] = PropertyPatternSample,
        [typeof(DiscardPattern)] = () -> Pattern(DiscardPattern()),
        [typeof(VarPattern)] = () -> Pattern(VarPattern("value")),
        [typeof(BinaryPattern)] = () -> Pattern(
            BinaryPattern(isConjunction: false, ConstantPattern(Int("1")), ConstantPattern(Int("2")))
        ),
        [typeof(NotPattern)] = () -> Pattern(NotPattern(ConstantPattern(Int("1")))),
        [typeof(ParenthesizedPattern)] = () -> Pattern(ParenthesizedPattern(ConstantPattern(Int("1")))),
        [typeof(ListPattern)] = () -> Pattern(
            ListPattern(List[GPattern](ConstantPattern(Int("1")), SlicePattern(nil), ConstantPattern(Int("4"))))
        ),
        [typeof(SlicePattern)] = () -> Pattern(ListPattern(List[GPattern](DiscardPattern(), SlicePattern("rest")))),
        [typeof(NamedTypeReference)] = () -> Field(
            NamedTypeReference("List", List[GTypeReference](GNodeSamples.Type("int32")))
        ),
        [typeof(ArrayTypeReference)] = () -> Field(ArrayTypeReference(GNodeSamples.Type("int32"))),
        [typeof(NativeSliceTypeReference)] = () -> Field(
            NativeSliceTypeReference(GNodeSamples.Type("int32"), isReadOnly: true)
        ),
        [typeof(ManagedReferenceTypeReference)] = () -> Field(
            ManagedReferenceTypeReference(GNodeSamples.Type("int32"), isReadOnly: true)
        ),
        [typeof(TupleTypeReference)] = () -> Field(
            TupleTypeReference(List[GTypeReference](GNodeSamples.Type("int32"), GNodeSamples.Type("string")))
        ),
        [typeof(PointerTypeReference)] = () -> Field(PointerTypeReference(GNodeSamples.Type("uint8"))),
        [typeof(ArrowTypeReference)] = () -> Field(
            ArrowTypeReference(
                List[GTypeReference](GNodeSamples.Type("int32")),
                List[GTypeReference](GNodeSamples.Type("int32"))
            )
        ),
        [typeof(FunctionPointerTypeReference)] = () -> Field(
            FunctionPointerTypeReference(
                isManaged: true,
                default(CallingConvention),
                List[GTypeReference](GNodeSamples.Type("int32")),
                GNodeSamples.Type("int32")
            )
        )
    }

    private func AttributeSample() CompilationUnit -> Unit(
        TypeDeclaration(
            TypeDeclarationKind.Class,
            "Old",
            attributes: GNodeSamples.List(
                AttributeUse("Obsolete", GNodeSamples.List(AttributeArgument(LiteralExpression.String("use New"))))
            )
        )
    )

    private func CompositeLiteralSample() CompilationUnit -> Expr(
        CompositeLiteralExpression(GNodeSamples.Type("Point"), GNodeSamples.List(FieldInitializer("X", Int("1"))))
    )

    private func CollectionInitializerSample() CompilationUnit -> Expr(
        CollectionInitializerExpression(
            InvocationExpression(Id("List"), typeArguments: List[GTypeReference](GNodeSamples.Type("int32"))),
            GNodeSamples.List(
                CollectionInitializerElement(Int("1")),
                CollectionInitializerElement(Int("2")),
                CollectionInitializerElement("Value", Int("3"))
            )
        )
    )

    private func SwitchExpressionSample() CompilationUnit -> Expr(
        SwitchExpression(
            Id("v"),
            GNodeSamples.List(SwitchArm(ConstantPattern(Int("0")), Int("1")), SwitchArm(nil, Int("2")))
        )
    )

    private func InterpolatedStringSample() CompilationUnit -> Expr(
        InterpolatedStringExpression(
            GNodeSamples.List(InterpolationPart.Literal("hi "), InterpolationPart.Hole(Id("who")))
        )
    )

    // ADR-0151: `let x = if let v = maybe && v.Length > 0 { v } else { "" }`.
    private func IfLetExpressionSample() CompilationUnit -> Expr(
        IfLetExpression(
            GNodeSamples.List(IfLetBinding("v", Id("maybe"))),
            BinaryExpression(MemberAccessExpression(Id("v"), "Length"), ">", Int("0")),
            Id("v"),
            LiteralExpression.String(string.Empty)
        )
    )

    private func ConditionalAccessSample() CompilationUnit -> Expr(
        ConditionalAccessExpression(Id("a"), MemberAccessExpression(ConditionalReceiverExpression(), "B"))
    )

    private func TrySample() CompilationUnit -> Stmts(
        TryStatement(Block(), GNodeSamples.List(CatchClause("e", GNodeSamples.Type("Exception"), Block())), Block())
    )

    private func SwitchStatementSample() CompilationUnit -> Stmts(
        SwitchStatement(
            Id("v"),
            GNodeSamples.List(
                SwitchStatementCase(ConstantPattern(Int("0")), Block()),
                SwitchStatementCase(nil, Block())
            )
        )
    )

    private func PropertySample() CompilationUnit -> Unit(
        TypeDeclaration(
            TypeDeclarationKind.Class,
            "C",
            members: Members(
                PropertyDeclaration(
                    "Area",
                    GNodeSamples.Type("int32"),
                    GNodeSamples.List(PropertyAccessor(AccessorKind.Get, Block(ReturnStatement(Int("1")))))
                )
            )
        )
    )

    private func EnumSample() CompilationUnit -> Unit(
        EnumDeclaration("Color", GNodeSamples.List(EnumCase("Red"), EnumCase("Green")))
    )

    private func PropertyPatternSample() CompilationUnit -> Pattern(
        PropertyPattern(GNodeSamples.List(PropertyPatternField("X", ConstantPattern(Int("0")))))
    )

    // A compilation unit with a package declaration and the given top-level nodes.
    private func Unit(members ...GNode) CompilationUnit -> CompilationUnit("Demo", members: members.ToList())

    // Wraps statements into a top-level `func Run() { ... }`.
    private func Stmts(statements ...GStatement) CompilationUnit -> Unit(
        MethodDeclaration("Run", body: Block(statements))
    )

    // Wraps an expression into `let x = <expr>` inside a func body.
    private func Expr(initializer GExpression) CompilationUnit -> Stmts(
        LocalDeclarationStatement(BindingKind.Let, "x", initializer: initializer)
    )

    // Wraps a pattern into a `switch` statement `case <pattern> { } default { }`.
    private func Pattern(pattern GPattern) CompilationUnit -> Stmts(
        SwitchStatement(
            Id("v"),
            GNodeSamples.List(SwitchStatementCase(pattern, Block()), SwitchStatementCase(nil, Block()))
        )
    )

    // Wraps a type reference into a top-level `var x <type>` declaration.
    private func Field(type GTypeReference) CompilationUnit -> Unit(FieldDeclaration(BindingKind.Var, "x", type))

    private func Type(name string) NamedTypeReference -> NamedTypeReference(name)

    private func Id(name string) IdentifierExpression -> IdentifierExpression(name)

    private func Int(value string) LiteralExpression -> LiteralExpression.Int(value)

    private func Block(statements ...GStatement) BlockStatement -> BlockStatement(statements.ToList())

    private func Members(members ...GMember) List[GMember] -> members.ToList()

    private func List[T](items ...T) List[T] -> items.ToList()
}
