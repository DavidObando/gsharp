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
    private readonly HashSet<VariableSymbol> managedLocations = new();
    private readonly HashSet<FunctionSymbol> analyzedFunctions = new();
    private bool analyzingStateMachine;

    private ManagedReferenceSafetyAnalyzer(DiagnosticBag diagnostics) => this.diagnostics = diagnostics;

    public static void Analyze(
        ImmutableDictionary<FunctionSymbol, BoundBlockStatement>.Builder functions,
        ImmutableArray<StructSymbol> types,
        ImmutableArray<InterfaceSymbol> interfaces,
        DiagnosticBag diagnostics)
    {
        var analyzer = new ManagedReferenceSafetyAnalyzer(diagnostics);
        foreach (var (function, body) in functions)
        {
            analyzer.AnalyzeFunction(function, body);
        }

        foreach (var type in types)
        {
            analyzer.CheckPrimaryConstructorParameters(type);
            analyzer.CheckBaseInitializer(type.BaseConstructorInitializer);
            foreach (var constructor in type.ExplicitConstructors)
            {
                analyzer.CheckBaseInitializer(constructor.BaseInitializer);
            }

            foreach (var initializer in type.InstanceFieldInitializers.Values.Concat(type.StaticFieldInitializers.Values))
            {
                analyzer.CheckScopedStore(initializer);
                analyzer.VisitExpression(initializer);
            }

            analyzer.Visit(new BoundBlockStatement(type.Declaration, type.StaticInitializerStatements));

            var fields = type.Fields.Where(f => analyzer.RequiredHandle(f.Type) != null).ToImmutableArray();
            if (fields.IsDefaultOrEmpty)
            {
                continue;
            }

            analyzer.CheckRequiredConstructorPaths(type, fields, functions);
        }

        foreach (var type in interfaces)
        {
            foreach (var field in type.StaticFields)
            {
                if (type.StaticFieldInitializers.TryGetValue(field, out var initializer))
                {
                    analyzer.CheckScopedStore(initializer);
                    analyzer.VisitExpression(initializer);
                }
                else if (analyzer.RequiredHandle(field.Type) != null)
                {
                    diagnostics.ReportManagedReference(
                        Invariant.Required(field.Declaration ?? type.Declaration, "source interface fields have a declaration").Location,
                        $"interface field '{field.Name}' requires a non-null managed-reference initializer");
                }
            }
        }
    }

    public override void VisitExpression(BoundExpression? node)
    {
        switch (node)
        {
            case BoundFunctionLiteralExpression literal:
                this.AnalyzeFunction(literal.Function, literal.Body);
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
            case BoundMapLiteralExpression map:
                foreach (var entry in map.Entries)
                {
                    this.CheckScopedStore(entry.Key);
                    this.CheckScopedStore(entry.Value);
                }

                break;
            case BoundConstructorCallExpression call:
                this.CheckConstruction(call.StructType, call, Enumerable.Empty<FieldSymbol?>(), call.SelectedConstructor != null);
                this.CheckConstructorArguments(call.Arguments, call.SelectedConstructor);

                break;
            case BoundConstructorChainingExpression chaining:
                this.CheckConstructorArguments(chaining.Arguments, chaining.SelectedConstructor);
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
                this.CheckScopedStore(field.Value, field);
                this.CheckSuspendingLocation(field.ReceiverExpression ?? VariableReceiver(field.Receiver), field.Value);
                break;
            case BoundPropertyAssignmentExpression property:
                this.CheckScopedStore(property.Value, property);
                this.CheckSuspendingLocation(property.Receiver, property.Value);
                break;
            case BoundClrPropertyAssignmentExpression property:
                this.CheckScopedStore(property.Value, property);
                this.CheckSuspendingLocation(property.Receiver, property.Value);
                break;
            case BoundIndexAssignmentExpression index:
                this.CheckScopedStore(index.Value, index);
                foreach (var argument in index.Indices)
                {
                    this.CheckScopedStore(argument);
                }

                break;
            case BoundClrIndexAssignmentExpression index:
                this.CheckScopedStore(index.Value, index);
                foreach (var argument in index.Arguments)
                {
                    this.CheckScopedStore(argument);
                    this.CheckSuspendingLocation(index.TargetExpression ?? VariableReceiver(index.Target), argument);
                }

                this.CheckSuspendingLocation(index.TargetExpression ?? VariableReceiver(index.Target), index.Value);
                break;
            case BoundClrConstructorCallExpression constructor:
                this.CheckConstructorArguments(constructor.Arguments, constructor: null);

                break;
            case BoundAssignmentExpression globalAssignment when globalAssignment.Variable is not LocalVariableSymbol { RefKind: RefKind.None }:
                this.CheckScopedStore(globalAssignment.Expression, globalAssignment);
                break;
            case BoundIndirectAssignmentExpression indirect:
                this.CheckScopedStore(indirect.Value, indirect);
                break;
            case BoundIndirectCallExpression indirect:
                this.CheckArguments(indirect.Arguments);
                break;
            case BoundBaseClassCallExpression baseCall:
                this.CheckArguments(baseCall.Arguments, baseCall.Method, baseCall.Receiver);
                break;
            case BoundClrIndexExpression index:
                this.CheckArguments(index.Arguments, receiver: index.Target);
                break;
            case BoundClrBinaryOperatorExpression binary when !IsManagedReferenceEquality(binary):
                this.CheckArguments(
                    ImmutableArray.Create(binary.Left, binary.Right),
                    binary.Function);
                break;
            case BoundClrUnaryOperatorExpression unary:
                this.CheckArguments(ImmutableArray.Create(unary.Operand));
                break;
            case BoundClrConversionCallExpression conversion:
                this.CheckArguments(
                    ImmutableArray.Create(conversion.Source),
                    conversion.Function);
                break;
        }

        if (node is BoundCallOperationExpression operation)
        {
            var receiver = operation switch
            {
                BoundImportedInstanceCallExpression call when !RefCapabilities.RequiresReadOnlyReceiverDefensiveCopy(call.Receiver, RefCapabilities.IsReadOnlyMethod(call.Method)) => call.Receiver,
                BoundUserInstanceCallExpression call when !RefCapabilities.RequiresReadOnlyReceiverDefensiveCopy(call.Receiver) => call.Receiver,
                BoundBaseInterfaceCallExpression call when !RefCapabilities.RequiresReadOnlyReceiverDefensiveCopy(call.Receiver) => call.Receiver,
                _ => null,
            };
            this.CheckArguments(operation.Arguments, operation.CalledFunction as FunctionSymbol, receiver);
        }

        if (node is BoundIndirectAssignmentExpression assignment
            && this.IsManagedLocation(assignment.Pointer) && AsyncBoundTreeQueries.HasAwait(assignment.Value))
        {
            this.Report(assignment, "a borrowed write cannot survive suspension; evaluate the value before selecting the borrow");
        }

        if (node?.Type is TupleTypeSymbol && ManagedReferenceOrigins.IsScopedHandle(node))
        {
            this.Report(node, "a scoped managed-reference value cannot be stored in an aggregate");
        }

        base.VisitExpression(node);
    }

    protected override void VisitVariableDeclaration(BoundVariableDeclaration node)
    {
        if (this.analyzingStateMachine && ManagedReferenceOrigins.IsScopedHandle(node.Variable))
        {
            this.Report(node, "a scoped managed-reference local cannot be retained by a state machine");
        }

        if (node.Initializer != null && node.Variable is GlobalVariableSymbol)
        {
            this.CheckScopedStore(node.Initializer, node);
        }

        if (node.Initializer != null && this.IsManagedLocation(node.Initializer)
            && (node.Variable.Type is ByRefTypeSymbol || node.Variable is LocalVariableSymbol { RefKind: not RefKind.None }))
        {
            this.managedLocations.Add(node.Variable);
        }

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

    protected override void VisitYieldStatement(BoundYieldStatement node)
    {
        this.CheckScopedStore(node.Expression);
        base.VisitYieldStatement(node);
    }

    private void AnalyzeFunction(FunctionSymbol function, BoundBlockStatement body)
    {
        if (!this.analyzedFunctions.Add(function))
        {
            return;
        }

        var previous = this.analyzingStateMachine;
        this.analyzingStateMachine = function.IsAsyncOrSuspending || IteratorDetection.ContainsYield(body);
        if (this.analyzingStateMachine)
        {
            foreach (var parameter in function.Parameters)
            {
                if (ManagedReferenceOrigins.IsScopedHandle(parameter))
                {
                    this.diagnostics.ReportManagedReference(
                        Invariant.Required(parameter.DeclaringSyntax ?? function.Declaration, "source parameters have a declaration").Location,
                        "a scoped managed-reference parameter cannot be retained by a state machine");
                }
            }
        }

        this.Visit(body);
        this.analyzingStateMachine = previous;
    }

    private void CheckArguments(ImmutableArray<BoundExpression> arguments, FunctionSymbol? target = null, BoundExpression? receiver = null)
    {
        var borrowed = false;
        for (var i = 0; i < arguments.Length; i++)
        {
            var argument = arguments[i];
            if (ManagedReferenceOrigins.IsScopedHandle(argument)
                && !(target != null && i < target.Parameters.Length && ManagedReferenceOrigins.IsScopedHandle(target.Parameters[i])))
            {
                this.Report(argument, "a scoped managed-reference value requires a scoped parameter");
            }

            this.CheckSuspendingLocation(receiver, argument);
            if (borrowed && AsyncBoundTreeQueries.HasAwait(argument))
            {
                this.Report(argument, "a borrowed argument cannot survive a later suspension; evaluate the suspending value before selecting the borrow");
            }

            borrowed |= argument.Type is ByRefTypeSymbol && this.IsManagedLocation(argument);
        }
    }

    private void CheckBaseInitializer(BaseConstructorInitializer? initializer)
    {
        if (initializer == null)
        {
            return;
        }

        this.CheckConstructorArguments(initializer.Arguments, initializer.GSharpConstructor);
        foreach (var argument in initializer.Arguments)
        {
            this.VisitExpression(argument);
        }
    }

    private void CheckConstructorArguments(ImmutableArray<BoundExpression> arguments, ConstructorSymbol? constructor)
    {
        if (constructor is { IsSynthesizedFromPrimaryConstructor: false })
        {
            this.CheckArguments(arguments, constructor.Function);
            return;
        }

        foreach (var argument in arguments)
        {
            this.CheckScopedStore(argument);
        }
    }

    private void CheckPrimaryConstructorParameters(StructSymbol type)
    {
        foreach (var parameter in type.PrimaryConstructorParameters)
        {
            if (!ManagedReferenceOrigins.IsScopedHandle(parameter))
            {
                continue;
            }

            this.diagnostics.ReportManagedReference(
                Invariant.Required(parameter.DeclaringSyntax ?? type.Declaration, "source primary parameters have a declaration").Location,
                "a scoped managed-reference primary-constructor parameter would be stored in an instance field");
        }
    }

    private void CheckRequiredConstructorPaths(
        StructSymbol type,
        ImmutableArray<FieldSymbol> fields,
        ImmutableDictionary<FunctionSymbol, BoundBlockStatement>.Builder functions)
    {
        foreach (var constructor in type.ExplicitConstructors)
        {
            if (constructor.IsConvenience)
            {
                continue;
            }

            if (constructor.IsSynthesizedFromPrimaryConstructor)
            {
                this.CheckImplicitConstructorPath(type, fields);
            }
            else if (functions.TryGetValue(constructor.Function, out var body))
            {
                var projection = new ConstructorAssignmentProjection(type, constructor, fields, this);
                DefiniteAssignmentAnalyzer.Analyze(projection.Project(body), constructor.Function, this.diagnostics);
            }
        }

        if ((type.ExplicitConstructors.IsDefaultOrEmpty && type.IsClass)
            || type.NeedsSynthesizedValueStructDefaultCtor)
        {
            this.CheckImplicitConstructorPath(type, fields);
        }
    }

    private void CheckImplicitConstructorPath(StructSymbol type, ImmutableArray<FieldSymbol> fields)
    {
        var initialized = type.InstanceFieldInitializers.Keys.Select(field => field.Name)
            .Concat(type.PrimaryConstructorParameters.Select(parameter => parameter.Name))
            .ToHashSet();
        foreach (var field in fields)
        {
            if (initialized.Contains(field.Name))
            {
                continue;
            }

            this.diagnostics.ReportManagedReference(
                Invariant.Required(field.Declaration ?? type.Declaration, "source fields have a declaration").Location,
                $"field '{field.Name}' must be initialized by every compiler-owned constructor path");
        }
    }

    private static bool IsManagedReferenceEquality(BoundClrBinaryOperatorExpression binary)
        => binary.OperatorKind is SyntaxKind.EqualsEqualsToken or SyntaxKind.BangEqualsToken
            && binary.Method is { Name: "op_Equality" or "op_Inequality", DeclaringType: { } declaringType }
            && ManagedReferenceTypes.IsDefinition(declaringType, out _);

    private void CheckSuspendingLocation(BoundExpression? receiver, BoundExpression value)
    {
        if (receiver != null && !Binder.IsReferenceTypeForConstraint(receiver.Type)
            && this.IsManagedLocation(receiver) && AsyncBoundTreeQueries.HasAwait(value))
        {
            this.Report(value, "a borrowed receiver cannot survive a later suspension; evaluate the suspending value before selecting the location");
        }
    }

    private bool IsManagedLocation(BoundExpression expression)
        => expression switch
        {
            BoundImportedInstanceCallExpression call => ManagedReferenceOrigins.IsHandleBorrow(call)
                || (call.Type is ByRefTypeSymbol && this.IsManagedLocation(call.Receiver)),
            BoundUserInstanceCallExpression call => call.Method.ReturnRefKind != RefKind.None && this.IsManagedLocation(call.Receiver),
            BoundPropertyAccessExpression property => property.Property.ReturnRefKind != RefKind.None
                && property.Receiver != null && this.IsManagedLocation(property.Receiver),
            BoundBlockExpression block => this.IsManagedLocation(block.Expression),
            BoundAddressOfExpression address => this.IsManagedLocation(address.Operand),
            BoundDereferenceExpression dereference => this.IsManagedLocation(dereference.Operand),
            BoundFieldAccessExpression { Receiver: { } receiver } => this.IsManagedLocation(receiver),
            BoundClrPropertyAccessExpression { Receiver: { } receiver, Member: FieldInfo } => this.IsManagedLocation(receiver),
            BoundIndexExpression index when index.IsArrayBackedElementAccess => this.IsManagedLocation(index.Target),
            BoundClrIndexExpression index when RefCapabilities.GetReturnRefKind(index.Indexer) != RefKind.None =>
                this.IsManagedLocation(index.Target),
            BoundClrPropertyAccessExpression { Receiver: { } receiver, Member: PropertyInfo property }
                when RefCapabilities.GetReturnRefKind(property) != RefKind.None => this.IsManagedLocation(receiver),
            BoundVariableExpression variable => this.managedLocations.Contains(variable.Variable)
                || (variable.Variable is LocalVariableSymbol { RefKind: not RefKind.None, ManagedReferenceOrigin: { } origin } && this.IsManagedLocation(origin)),
            _ => false,
        };

    private static BoundExpression? VariableReceiver(VariableSymbol? variable)
        => variable == null ? null : new BoundVariableExpression(variable.DeclaringSyntax, variable);

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
                && !type.Definition.InstanceFieldInitializers.Keys.Any(declared => declared.Name == field.Name)
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

    private void Report(BoundNode node, string reason, BoundNode? fallback = null)
    {
        if ((node.Syntax ?? fallback?.Syntax) is { } syntax)
        {
            this.diagnostics.ReportManagedReference(syntax.Location, reason);
        }
    }

    private void CheckScopedStore(BoundExpression value, BoundNode? sink = null)
    {
        if (ManagedReferenceOrigins.IsScopedHandle(value))
        {
            this.Report(value, "a scoped managed-reference value cannot be stored in heap-owned or unknown storage", sink);
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
