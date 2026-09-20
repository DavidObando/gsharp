// <copyright file="ManagedReferenceSafetyAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>Checks initialization and segment-local borrowed adapters without changing their ABI.</summary>
internal sealed class ManagedReferenceSafetyAnalyzer : BoundTreeWalker
{
    private readonly DiagnosticBag diagnostics;
    private readonly Dictionary<TypeSymbol, TypeSymbol?> required = new();

    private ManagedReferenceSafetyAnalyzer(DiagnosticBag diagnostics) => this.diagnostics = diagnostics;

    public static void Analyze(
        ImmutableDictionary<FunctionSymbol, BoundBlockStatement>.Builder functions,
        ImmutableArray<StructSymbol> types,
        DiagnosticBag diagnostics)
    {
        var analyzer = new ManagedReferenceSafetyAnalyzer(diagnostics);
        foreach (var body in functions.Values)
        {
            analyzer.Visit(body);
        }

        foreach (var type in types)
        {
            foreach (var initializer in type.InstanceFieldInitializers.Values.Concat(type.StaticFieldInitializers.Values))
            {
                analyzer.VisitExpression(initializer);
            }

            var fields = type.Fields.Where(f => analyzer.RequiredHandle(f.Type) != null).ToImmutableArray();
            if (fields.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var constructor in type.ExplicitConstructors)
            {
                if (functions.TryGetValue(constructor.Function, out var body))
                {
                    var projection = new ConstructorAssignmentProjection(type, constructor, fields, analyzer);
                    DefiniteAssignmentAnalyzer.Analyze(projection.Project(body), constructor.Function, diagnostics);
                }
            }
        }
    }

    public override void VisitExpression(BoundExpression? node)
    {
        switch (node)
        {
            case BoundFunctionLiteralExpression literal:
                this.Visit(literal.Body);
                return;
            case BoundDefaultExpression value when this.RequiredHandle(value.Type) != null:
                this.Report(value, "default would synthesize a null non-null managed-reference slot; use a nullable handle or initialize the aggregate");
                break;
            case BoundStructLiteralExpression literal:
                this.CheckConstruction(literal.StructType, literal, literal.Initializers.Where(i => i.Field != null).Select(i => i.Field), explicitConstructor: false);
                foreach (var initializer in literal.Initializers)
                {
                    this.CheckScopedStore(initializer.Value);
                }

                break;
            case BoundConstructorCallExpression call:
                this.CheckConstruction(call.StructType, call, Enumerable.Empty<FieldSymbol?>(), call.SelectedConstructor != null);
                foreach (var argument in call.Arguments)
                {
                    this.CheckScopedStore(argument);
                }

                break;
            case BoundArrayCreationExpression array:
                if (this.RequiredHandle(array.ElementType) != null
                    && (array.LengthExpression != null || (array.ContainerType is ArrayTypeSymbol fixedArray && fixedArray.Length > array.Elements.Length)))
                {
                    this.Report(array, "array initialization must supply every non-null managed-reference element");
                }

                foreach (var element in array.Elements)
                {
                    this.CheckScopedStore(element);
                }

                break;
            case BoundFieldAssignmentExpression field:
                this.CheckScopedStore(field.Value);
                break;
            case BoundPropertyAssignmentExpression property:
                this.CheckScopedStore(property.Value);
                break;
            case BoundClrPropertyAssignmentExpression property:
                this.CheckScopedStore(property.Value);
                break;
            case BoundIndexAssignmentExpression index:
                this.CheckScopedStore(index.Value);
                break;
            case BoundClrIndexAssignmentExpression index:
                this.CheckScopedStore(index.Value);
                break;
            case BoundClrConstructorCallExpression constructor:
                foreach (var argument in constructor.Arguments)
                {
                    this.CheckScopedStore(argument);
                }

                break;
            case BoundAssignmentExpression { Variable: not LocalVariableSymbol } globalAssignment:
                this.CheckScopedStore(globalAssignment.Expression);
                break;
            case BoundIndirectAssignmentExpression indirect:
                this.CheckScopedStore(indirect.Value);
                break;
        }

        if (node is BoundCallOperationExpression operation)
        {
            var borrowed = false;
            for (var i = 0; i < operation.Arguments.Length; i++)
            {
                var argument = operation.Arguments[i];
                if (ManagedReferenceOrigins.IsScopedHandle(argument)
                    && !(operation.CalledFunction is FunctionSymbol target && i < target.Parameters.Length
                        && target.Parameters[i].IsScoped && ManagedReferenceTypes.TryGetElement(target.Parameters[i].Type, out _, out _)))
                {
                    this.Report(argument, "a scoped managed-reference value requires a scoped parameter");
                }

                if (borrowed && AsyncBoundTreeQueries.HasAwait(argument))
                {
                    this.Report(argument, "a borrowed argument cannot survive a later suspension; evaluate the suspending value before selecting the borrow");
                }

                borrowed |= ContainsManagedBorrow(argument);
            }
        }

        if (node is BoundIndirectAssignmentExpression assignment
            && ContainsManagedBorrow(assignment.Pointer) && AsyncBoundTreeQueries.HasAwait(assignment.Value))
        {
            this.Report(assignment, "a borrowed write cannot survive suspension; evaluate the value before selecting the borrow");
        }

        if (node?.Type is TupleTypeSymbol)
        {
            var scoped = new ScopedValueFinder();
            scoped.VisitExpression(node);
            if (scoped.Found)
            {
                this.Report(node, "a scoped managed-reference value cannot be stored in an aggregate");
            }
        }

        base.VisitExpression(node);
    }

    protected override void VisitVariableDeclaration(BoundVariableDeclaration node)
    {
        if (node.Initializer is BoundDefaultExpression
            && node.Variable is LocalVariableSymbol
            && node.Syntax is VariableDeclarationSyntax { Initializer: null }
            && ManagedReferenceTypes.TryGetElement(node.Variable.Type, out _, out _))
        {
            // The existing definite-assignment pass checks every use.
            return;
        }

        base.VisitVariableDeclaration(node);
    }

    private void CheckConstruction(StructSymbol type, BoundExpression node, IEnumerable<FieldSymbol?> initialized, bool explicitConstructor)
    {
        if (explicitConstructor || type.ExplicitConstructors.Any(c => c.Parameters.IsEmpty))
        {
            return;
        }

        var supplied = initialized.OfType<FieldSymbol>().Select(f => f.Name).ToHashSet();
        foreach (var field in type.Fields)
        {
            if (this.RequiredHandle(field.Type) != null && !supplied.Contains(field.Name)
                && !type.InstanceFieldInitializers.ContainsKey(field)
                && !type.PrimaryConstructorParameters.Any(p => p.Name == field.Name))
            {
                this.Report(node, $"construction must initialize non-null managed-reference field '{field.Name}'");
            }
        }
    }

    private TypeSymbol? RequiredHandle(TypeSymbol type)
    {
        if (this.required.TryGetValue(type, out var found))
        {
            return found;
        }

        this.required[type] = null;
        if (ManagedReferenceTypes.TryGetElement(type, out _, out _))
        {
            this.required[type] = type;
            return type;
        }

        IEnumerable<TypeSymbol> fields;
        if (type is StructSymbol { IsClass: false } source)
        {
            fields = source.Fields.Select(f => f.Type);
        }
        else if (type is TupleTypeSymbol tuple)
        {
            fields = tuple.ElementTypes;
        }
        else if (type is not NullableTypeSymbol and not TypeParameterSymbol && type.ClrType is { IsValueType: true, IsPrimitive: false, IsEnum: false, IsGenericParameter: false } clr)
        {
            fields = clr.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic).Select(ClrNullability.GetFieldTypeSymbol);
        }
        else
        {
            return null;
        }

        foreach (var field in fields)
        {
            if (this.RequiredHandle(field) is { } handle)
            {
                this.required[type] = handle;
                return handle;
            }
        }

        return null;
    }

    private void Report(BoundNode node, string reason)
    {
        if (node.Syntax is { } syntax)
        {
            this.diagnostics.ReportManagedReference(syntax.Location, reason);
        }
    }

    private void CheckScopedStore(BoundExpression value)
    {
        if (ManagedReferenceOrigins.IsScopedHandle(value))
        {
            this.Report(value, "a scoped managed-reference value cannot be stored in heap-owned or unknown storage");
        }
    }

    private static bool ContainsManagedBorrow(BoundExpression expression)
    {
        var visitor = new BorrowFinder();
        visitor.VisitExpression(expression);
        return visitor.Found;
    }

    private sealed class BorrowFinder : BoundTreeWalker
    {
        internal bool Found { get; private set; }

        protected override void VisitImportedInstanceCallExpression(BoundImportedInstanceCallExpression node)
        {
            this.Found |= ManagedReferenceOrigins.IsHandleBorrow(node);
            base.VisitImportedInstanceCallExpression(node);
        }
    }

    private sealed class ScopedValueFinder : BoundTreeWalker
    {
        internal bool Found { get; private set; }

        public override void VisitExpression(BoundExpression? node)
        {
            this.Found |= node != null && ManagedReferenceOrigins.IsScopedHandle(node);
            base.VisitExpression(node);
        }
    }

    private sealed class ConstructorAssignmentProjection : BoundTreeRewriter
    {
        private readonly StructSymbol type;
        private readonly FunctionSymbol function;
        private readonly SyntaxNode? syntax;
        private readonly Dictionary<FieldSymbol, LocalVariableSymbol> fields = new();

        internal ConstructorAssignmentProjection(StructSymbol type, ConstructorSymbol constructor, ImmutableArray<FieldSymbol> fields, ManagedReferenceSafetyAnalyzer analyzer)
        {
            this.type = type;
            this.function = constructor.Function;
            this.syntax = constructor.Declaration;
            foreach (var field in fields)
            {
                this.fields.Add(field, new LocalVariableSymbol(
                    field.Name,
                    false,
                    Invariant.Required(analyzer.RequiredHandle(field.Type), "the caller selected required managed-reference fields")));
            }
        }

        internal BoundBlockStatement Project(BoundBlockStatement body)
        {
            var prefix = ImmutableArray.CreateBuilder<BoundStatement>();
            foreach (var pair in this.fields)
            {
                var initializer = this.type.InstanceFieldInitializers.TryGetValue(pair.Key, out var value)
                    ? value : new BoundDefaultExpression(this.syntax, pair.Value.Type);
                prefix.Add(new BoundVariableDeclaration(this.syntax, pair.Value, initializer));
            }

            prefix.AddRange(((BoundBlockStatement)this.RewriteStatement(body)).Statements);
            prefix.AddRange(this.ReadFields());
            return new BoundBlockStatement(body.Syntax, prefix.ToImmutable());
        }

        protected override BoundExpression RewriteFieldAssignmentExpression(BoundFieldAssignmentExpression node)
        {
            if (this.fields.TryGetValue(node.Field, out var variable)
                && (node.Receiver == this.function.ThisParameter
                    || (node.ReceiverExpression is BoundVariableExpression receiver && receiver.Variable == this.function.ThisParameter)))
            {
                return new BoundAssignmentExpression(node.Syntax, variable, this.RewriteExpression(node.Value));
            }

            return base.RewriteFieldAssignmentExpression(node);
        }

        protected override BoundStatement RewriteReturnStatement(BoundReturnStatement node)
            => new BoundBlockStatement(node.Syntax, this.ReadFields().Add(node));

        private ImmutableArray<BoundStatement> ReadFields()
            => this.fields.Values.Select(variable => (BoundStatement)new BoundExpressionStatement(
                this.syntax, new BoundVariableExpression(this.syntax, variable))).ToImmutableArray();
    }
}
