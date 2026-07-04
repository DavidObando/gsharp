// <copyright file="GNodeSamples.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;

namespace Cs2Gs.Tests.Coverage;

/// <summary>
/// Registry mapping every concrete <see cref="GNode"/> subclass to a factory
/// producing a minimal <see cref="CompilationUnit"/> that exercises that node
/// through the canonical printer and the real G# parser.
/// <see cref="PrinterExhaustivenessTests"/> asserts the registry stays total
/// as the code model grows: when a new node type is added, add printer
/// coverage and a tiny sample here.
/// </summary>
public static class GNodeSamples
{
    /// <summary>
    /// Gets, for every concrete <see cref="GNode"/> subclass, a factory
    /// building a minimal compilation unit exercising that node type.
    /// </summary>
    public static IReadOnlyDictionary<Type, Func<CompilationUnit>> All { get; } = Build();

    private static IReadOnlyDictionary<Type, Func<CompilationUnit>> Build() =>
        new Dictionary<Type, Func<CompilationUnit>>
        {
            // Root and support nodes.
            [typeof(CompilationUnit)] = () => Unit(new MethodDeclaration("Run", body: Block())),
            [typeof(ImportDirective)] = () => new CompilationUnit("Demo", List(new ImportDirective("System"))),
            [typeof(Parameter)] = () => Unit(new MethodDeclaration(
                "Echo",
                parameters: List(new Parameter("n", Type("int32"))),
                returnType: Type("int32"),
                body: Block(new ReturnStatement(Id("n"))))),
            [typeof(TypeParameter)] = () => Unit(new MethodDeclaration(
                "First",
                parameters: List(new Parameter("v", Type("T"))),
                returnType: Type("T"),
                typeParameters: List(new TypeParameter("T", "any")),
                body: Block(new ReturnStatement(Id("v"))))),
            [typeof(AttributeArgument)] = AttributeSample,
            [typeof(AttributeUse)] = AttributeSample,
            [typeof(Receiver)] = () => Unit(new MethodDeclaration(
                "Doubled",
                returnType: Type("int32"),
                receiver: new Receiver("v", Type("int32")),
                body: Block(new ReturnStatement(new BinaryExpression(Id("v"), "*", Int("2")))))),

            // Expressions.
            [typeof(LiteralExpression)] = () => Expr(Int("42")),
            [typeof(IdentifierExpression)] = () => Expr(Id("y")),
            [typeof(ThisExpression)] = () => Unit(new TypeDeclaration(
                TypeDeclarationKind.Class,
                "C",
                members: Members(new MethodDeclaration(
                    "Self",
                    returnType: Type("C"),
                    body: Block(new ReturnStatement(new ThisExpression())))))),
            [typeof(MemberAccessExpression)] = () => Expr(new MemberAccessExpression(Id("a"), "B")),
            [typeof(InvocationExpression)] = () => Expr(new InvocationExpression(Id("f"), List<GExpression>(Id("v")))),
            [typeof(IndexExpression)] = () => Expr(new IndexExpression(Id("a"), Int("0"))),
            [typeof(FromEndIndexExpression)] = () => Expr(new IndexExpression(Id("a"), new FromEndIndexExpression(Int("1")))),
            [typeof(RangeIndexExpression)] = () => Expr(new IndexExpression(
                Id("a"), new RangeIndexExpression(Int("1"), new FromEndIndexExpression(Int("1"))))),
            [typeof(FieldInitializer)] = CompositeLiteralSample,
            [typeof(CompositeLiteralExpression)] = CompositeLiteralSample,
            [typeof(ObjectCreationInitializerExpression)] = () => Expr(new ObjectCreationInitializerExpression(
                new InvocationExpression(Id("Foo"), List<GExpression>(Int("1"))),
                List(new FieldInitializer("Bar", Int("2"))))),
            [typeof(CollectionInitializerElement)] = CollectionInitializerSample,
            [typeof(CollectionInitializerExpression)] = CollectionInitializerSample,
            [typeof(ArrayLiteralExpression)] = () => Expr(new ArrayLiteralExpression(Type("int32"), List<GExpression>(Int("1"), Int("2")))),
            [typeof(ArrayAllocationExpression)] = () => Expr(new ArrayAllocationExpression(Type("int32"), Int("3"))),
            [typeof(ConversionExpression)] = () => Expr(new ConversionExpression(Type("int32"), Id("y"))),
            [typeof(WithExpression)] = () => Expr(new WithExpression(Id("p"), List(new FieldInitializer("X", Int("2"))))),
            [typeof(TupleLiteralExpression)] = () => Expr(new TupleLiteralExpression(List<GExpression>(Int("1"), Int("2")))),
            [typeof(BinaryExpression)] = () => Expr(new BinaryExpression(Int("1"), "+", Int("2"))),
            [typeof(UnaryExpression)] = () => Expr(new UnaryExpression("-", Id("y"))),
            [typeof(NonNullAssertionExpression)] = () => Expr(new NonNullAssertionExpression(Id("y"))),
            [typeof(IncrementDecrementExpression)] = () => Expr(new IncrementDecrementExpression(Id("i"), "++", isPrefix: false)),
            [typeof(StackAllocExpression)] = () => Stmts(new BlockStatement(
                List<GStatement>(new LocalDeclarationStatement(
                    BindingKind.Let,
                    "x",
                    initializer: new StackAllocExpression(Type("uint8"), Int("4")))),
                isUnsafe: true)),
            [typeof(ParenthesizedExpression)] = () => Expr(new ParenthesizedExpression(Int("1"))),
            [typeof(CheckedExpression)] = () => Expr(new CheckedExpression(new BinaryExpression(Int("1"), "+", Int("2")), isChecked: true)),
            [typeof(LambdaExpression)] = () => Expr(new LambdaExpression(
                List(new Parameter("n", Type("int32"))),
                expressionBody: Id("n"))),
            [typeof(AwaitExpression)] = () => Unit(new MethodDeclaration(
                "RunAsync",
                returnType: Type("int32"),
                body: Block(new ReturnStatement(new AwaitExpression(new InvocationExpression(Id("f"))))),
                isAsync: true)),
            [typeof(SwitchArm)] = SwitchExpressionSample,
            [typeof(SwitchExpression)] = SwitchExpressionSample,
            [typeof(InterpolationPart)] = InterpolatedStringSample,
            [typeof(InterpolatedStringExpression)] = InterpolatedStringSample,
            [typeof(IfExpression)] = () => Expr(new IfExpression(Id("c"), Int("1"), Int("2"))),
            [typeof(OutArgumentExpression)] = () => Stmts(new ExpressionStatement(new InvocationExpression(
                Id("M"),
                List<GExpression>(new OutArgumentExpression("out var", "x"))))),
            [typeof(TypeOfExpression)] = () => Expr(new TypeOfExpression(Type("string"))),
            [typeof(DefaultValueExpression)] = () => Expr(new DefaultValueExpression(Type("int32"))),
            [typeof(TypeExpression)] = () => Expr(new BinaryExpression(Id("o"), "as", new TypeExpression(Type("string")))),
            [typeof(ConditionalReceiverExpression)] = ConditionalAccessSample,
            [typeof(ConditionalAccessExpression)] = ConditionalAccessSample,
            [typeof(ThrowExpression)] = () => Expr(new BinaryExpression(
                Id("y"),
                "??",
                new ThrowExpression(
                    new InvocationExpression(Id("Exception"), List<GExpression>(LiteralExpression.String("boom"))),
                    null))),

            // Statements.
            [typeof(BlockStatement)] = () => Stmts(),
            [typeof(LocalDeclarationStatement)] = () => Stmts(new LocalDeclarationStatement(BindingKind.Var, "n", Type("int32"), Int("0"))),
            [typeof(ExpressionStatement)] = () => Stmts(new ExpressionStatement(new InvocationExpression(Id("f")))),
            [typeof(AssignmentStatement)] = () => Stmts(new AssignmentStatement(Id("x"), Int("1"))),
            [typeof(ReturnStatement)] = () => Unit(new MethodDeclaration(
                "One",
                returnType: Type("int32"),
                body: Block(new ReturnStatement(Int("1"))))),
            [typeof(IfStatement)] = () => Stmts(new IfStatement(Id("c"), Block(), Block())),
            [typeof(WhileStatement)] = () => Stmts(new WhileStatement(Id("c"), Block())),
            [typeof(LockStatement)] = () => Stmts(new LockStatement(Id("gate"), Block())),
            [typeof(ForStatement)] = () => Stmts(new ForStatement(
                new LocalDeclarationStatement(BindingKind.Var, "i", initializer: Int("0")),
                new BinaryExpression(Id("i"), "<", Int("3")),
                new IncrementDecrementStatement(Id("i"), "++"),
                Block())),
            [typeof(IncrementDecrementStatement)] = () => Stmts(
                new LocalDeclarationStatement(BindingKind.Var, "i", initializer: Int("0")),
                new IncrementDecrementStatement(Id("i"), "++")),
            [typeof(ForInStatement)] = () => Stmts(new ForInStatement("item", Id("items"), Block())),
            [typeof(ForTupleInStatement)] = () => Stmts(new ForTupleInStatement(new[] { "a", "b" }, Id("items"), Block())),
            [typeof(ThrowStatement)] = () => Stmts(new ThrowStatement(
                new InvocationExpression(Id("Exception"), List<GExpression>(LiteralExpression.String("boom"))))),
            [typeof(DeferStatement)] = () => Stmts(new DeferStatement(new InvocationExpression(Id("cleanup")))),
            [typeof(RawStatement)] = () => Stmts(new RawStatement("let raw = 1")),
            [typeof(CatchClause)] = TrySample,
            [typeof(TryStatement)] = TrySample,
            [typeof(SwitchStatementCase)] = SwitchStatementSample,
            [typeof(SwitchStatement)] = SwitchStatementSample,
            [typeof(YieldStatement)] = () => Unit(new MethodDeclaration(
                "Numbers",
                returnType: new NamedTypeReference("sequence", List<GTypeReference>(Type("int32"))),
                body: Block(new YieldStatement(Int("1"))))),
            [typeof(BreakStatement)] = () => Stmts(new WhileStatement(Id("c"), Block(new BreakStatement()))),
            [typeof(ContinueStatement)] = () => Stmts(new WhileStatement(Id("c"), Block(new ContinueStatement()))),
            [typeof(GotoStatement)] = () => Stmts(new GotoStatement("retry")),
            [typeof(LabeledStatement)] = () => Stmts(new LabeledStatement("retry", new GotoStatement("retry"))),
            [typeof(DoWhileStatement)] = () => Stmts(new DoWhileStatement(Block(), Id("c"))),
            [typeof(TupleDeconstructionStatement)] = () => Stmts(new TupleDeconstructionStatement(
                BindingKind.Let,
                List("a", "b"),
                Id("t"))),
            [typeof(LocalFunctionStatement)] = () => Stmts(new LocalFunctionStatement(
                "helper",
                new LambdaExpression(
                    List<Parameter>(),
                    blockBody: Block(new ReturnStatement(Int("1"))),
                    returnType: Type("int32"),
                    isFunctionLiteral: true))),
            [typeof(FixedStatement)] = () => Stmts(new BlockStatement(
                List<GStatement>(new FixedStatement("p", new PointerTypeReference(Type("uint8")), Id("buffer"), Block())),
                isUnsafe: true)),

            // Members.
            [typeof(FieldDeclaration)] = () => Unit(new FieldDeclaration(BindingKind.Var, "count", Type("int32"))),
            [typeof(PropertyAccessor)] = PropertySample,
            [typeof(PropertyDeclaration)] = PropertySample,
            [typeof(MethodDeclaration)] = () => Unit(new MethodDeclaration("Run", body: Block())),
            [typeof(ConstructorDeclaration)] = () => Unit(new TypeDeclaration(
                TypeDeclarationKind.Class,
                "C",
                members: Members(new ConstructorDeclaration(List(new Parameter("n", Type("int32"))), Block())))),
            [typeof(SharedBlock)] = () => Unit(new TypeDeclaration(
                TypeDeclarationKind.Class,
                "C",
                members: Members(new SharedBlock(Members(new MethodDeclaration(
                    "Zero",
                    returnType: Type("int32"),
                    body: Block(new ReturnStatement(Int("0"))))))))),
            [typeof(DestructorDeclaration)] = () => Unit(new TypeDeclaration(
                TypeDeclarationKind.Class,
                "C",
                members: Members(new DestructorDeclaration(Block())))),
            [typeof(EventDeclaration)] = () => Unit(new TypeDeclaration(
                TypeDeclarationKind.Class,
                "C",
                members: Members(new EventDeclaration("Changed", Type("EventHandler"))))),
            [typeof(TypeDeclaration)] = () => Unit(new TypeDeclaration(TypeDeclarationKind.Class, "C")),
            [typeof(EnumCase)] = EnumSample,
            [typeof(EnumDeclaration)] = EnumSample,
            [typeof(NamedDelegateDeclaration)] = () => Unit(new NamedDelegateDeclaration(
                "Combine",
                List(new Parameter("a", Type("int32"))),
                Type("int32"))),

            // Patterns.
            [typeof(ConstantPattern)] = () => Pattern(new ConstantPattern(Int("0"))),
            [typeof(RelationalPattern)] = () => Pattern(new RelationalPattern("<", Int("10"))),
            [typeof(TypePattern)] = () => Pattern(new TypePattern("s", Type("string"))),
            [typeof(PropertyPatternField)] = PropertyPatternSample,
            [typeof(PropertyPattern)] = PropertyPatternSample,
            [typeof(DiscardPattern)] = () => Pattern(new DiscardPattern()),
            [typeof(BinaryPattern)] = () => Pattern(new BinaryPattern(
                isConjunction: false,
                new ConstantPattern(Int("1")),
                new ConstantPattern(Int("2")))),
            [typeof(NotPattern)] = () => Pattern(new NotPattern(new ConstantPattern(Int("1")))),
            [typeof(ParenthesizedPattern)] = () => Pattern(new ParenthesizedPattern(new ConstantPattern(Int("1")))),
            [typeof(ListPattern)] = () => Pattern(new ListPattern(List<GPattern>(
                new ConstantPattern(Int("1")), new SlicePattern(null), new ConstantPattern(Int("4"))))),
            [typeof(SlicePattern)] = () => Pattern(new ListPattern(List<GPattern>(
                new DiscardPattern(), new SlicePattern("rest")))),

            // Type references.
            [typeof(NamedTypeReference)] = () => Field(new NamedTypeReference("List", List<GTypeReference>(Type("int32")))),
            [typeof(ArrayTypeReference)] = () => Field(new ArrayTypeReference(Type("int32"))),
            [typeof(TupleTypeReference)] = () => Field(new TupleTypeReference(List<GTypeReference>(Type("int32"), Type("string")))),
            [typeof(PointerTypeReference)] = () => Field(new PointerTypeReference(Type("uint8"))),
            [typeof(ArrowTypeReference)] = () => Field(new ArrowTypeReference(
                List<GTypeReference>(Type("int32")),
                List<GTypeReference>(Type("int32")))),
            [typeof(FunctionPointerTypeReference)] = () => Field(new FunctionPointerTypeReference(
                isManaged: true,
                default,
                List<GTypeReference>(Type("int32")),
                Type("int32"))),
        };

    private static CompilationUnit AttributeSample() => Unit(new TypeDeclaration(
        TypeDeclarationKind.Class,
        "Old",
        attributes: List(new AttributeUse("Obsolete", List(new AttributeArgument(LiteralExpression.String("use New")))))));

    private static CompilationUnit CompositeLiteralSample() =>
        Expr(new CompositeLiteralExpression(Type("Point"), List(new FieldInitializer("X", Int("1")))));

    private static CompilationUnit CollectionInitializerSample() =>
        Expr(new CollectionInitializerExpression(
            new InvocationExpression(Id("List"), typeArguments: List<GTypeReference>(Type("int32"))),
            List(new CollectionInitializerElement(Int("1")), new CollectionInitializerElement(Int("2")))));

    private static CompilationUnit SwitchExpressionSample() =>
        Expr(new SwitchExpression(Id("v"), List(
            new SwitchArm(new ConstantPattern(Int("0")), Int("1")),
            new SwitchArm(null, Int("2")))));

    private static CompilationUnit InterpolatedStringSample() =>
        Expr(new InterpolatedStringExpression(List(
            InterpolationPart.Literal("hi "),
            InterpolationPart.Hole(Id("who")))));

    private static CompilationUnit ConditionalAccessSample() =>
        Expr(new ConditionalAccessExpression(
            Id("a"),
            new MemberAccessExpression(new ConditionalReceiverExpression(), "B")));

    private static CompilationUnit TrySample() => Stmts(new TryStatement(
        Block(),
        List(new CatchClause("e", Type("Exception"), Block())),
        Block()));

    private static CompilationUnit SwitchStatementSample() => Stmts(new SwitchStatement(Id("v"), List(
        new SwitchStatementCase(new ConstantPattern(Int("0")), Block()),
        new SwitchStatementCase(null, Block()))));

    private static CompilationUnit PropertySample() => Unit(new TypeDeclaration(
        TypeDeclarationKind.Class,
        "C",
        members: Members(new PropertyDeclaration(
            "Area",
            Type("int32"),
            List(new PropertyAccessor(AccessorKind.Get, Block(new ReturnStatement(Int("1")))))))));

    private static CompilationUnit EnumSample() =>
        Unit(new EnumDeclaration("Color", List(new EnumCase("Red"), new EnumCase("Green"))));

    private static CompilationUnit PropertyPatternSample() =>
        Pattern(new PropertyPattern(List(new PropertyPatternField("X", new ConstantPattern(Int("0"))))));

    // A compilation unit with a package declaration and the given top-level nodes.
    private static CompilationUnit Unit(params GNode[] members) => new CompilationUnit("Demo", members: members.ToList());

    // Wraps statements into a top-level `func Run() { ... }`.
    private static CompilationUnit Stmts(params GStatement[] statements) =>
        Unit(new MethodDeclaration("Run", body: Block(statements)));

    // Wraps an expression into `let x = <expr>` inside a func body.
    private static CompilationUnit Expr(GExpression initializer) =>
        Stmts(new LocalDeclarationStatement(BindingKind.Let, "x", initializer: initializer));

    // Wraps a pattern into a `switch` statement `case <pattern> { } default { }`.
    private static CompilationUnit Pattern(GPattern pattern) =>
        Stmts(new SwitchStatement(Id("v"), List(
            new SwitchStatementCase(pattern, Block()),
            new SwitchStatementCase(null, Block()))));

    // Wraps a type reference into a top-level `var x <type>` declaration.
    private static CompilationUnit Field(GTypeReference type) =>
        Unit(new FieldDeclaration(BindingKind.Var, "x", type));

    private static NamedTypeReference Type(string name) => new NamedTypeReference(name);

    private static IdentifierExpression Id(string name) => new IdentifierExpression(name);

    private static LiteralExpression Int(string value) => LiteralExpression.Int(value);

    private static BlockStatement Block(params GStatement[] statements) => new BlockStatement(statements.ToList());

    private static List<GMember> Members(params GMember[] members) => members.ToList();

    private static List<T> List<T>(params T[] items) => items.ToList();
}
