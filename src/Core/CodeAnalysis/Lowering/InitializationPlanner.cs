// <copyright file="InitializationPlanner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering;

internal static class InitializationPlanner
{
    internal static BoundProgram Prepare(BoundProgram program)
    {
        if (!program.Initializers.IsEmpty)
        {
            return program;
        }

        var plans = program.Initializers.ToBuilder();
        var functions = program.Functions.ToBuilder();
        foreach (var type in program.Structs)
        {
            var fields = type.InstanceFieldInitializers.Values;
            var primary = type.BaseConstructorInitializer?.Arguments ?? ImmutableArray<BoundExpression>.Empty;
            if ((type.ExplicitConstructor == null || type.HasPrimaryConstructor || type.NeedsSynthesizedValueStructDefaultCtor)
                && HasRequest(fields.Concat(primary)))
            {
                var function = OwnerFunction(program, type, type.PrimaryConstructorParameters, isStatic: false);
                plans[(type, false)] = InstancePlan(type, function, primary, Empty(), primaryStores: true);
            }

            foreach (var constructor in type.ExplicitConstructors.Where(c => !c.IsSynthesizedFromPrimaryConstructor))
            {
                if (!functions.TryGetValue(constructor.Function, out var body))
                {
                    continue;
                }

                var arguments = constructor.BaseInitializer?.Arguments ?? ImmutableArray<BoundExpression>.Empty;
                if (!HasRequest(fields.Concat(arguments)) && !HasRequest(body))
                {
                    continue;
                }

                plans[(constructor.Function, false)] = constructor.IsConvenience
                    ? new BoundInitializationPlan(constructor.Function, arguments, Empty(), body)
                    : InstancePlan(type, constructor.Function, arguments, body, primaryStores: false);
                functions.Remove(constructor.Function);
            }

            var staticBody = new BoundBlockStatement(null, type.StaticInitializerStatements);
            if (HasRequest(type.StaticFieldInitializers.Values) || HasRequest(staticBody))
            {
                var function = OwnerFunction(program, type, ImmutableArray<ParameterSymbol>.Empty, isStatic: true);
                var statements = ImmutableArray.CreateBuilder<BoundStatement>();
                foreach (var field in type.ConstFields.Where(f => ConstantFieldMetadataEmitter.RequiresRuntimeInitialization(f.ConstantValue)))
                {
                    statements.Add(new BoundExpressionStatement(
                        null,
                        new BoundFieldAssignmentExpression(null, null, type, field, new BoundLiteralExpression(null, field.ConstantValue, field.Type))));
                }

                foreach (var field in type.StaticFields)
                {
                    if (type.StaticFieldInitializers.TryGetValue(field, out var initializer))
                    {
                        statements.Add(new BoundExpressionStatement(
                            initializer.Syntax,
                            new BoundFieldAssignmentExpression(initializer.Syntax, null, type, field, initializer)));
                    }
                }

                statements.AddRange(type.StaticInitializerStatements);
                plans[(type, true)] = new BoundInitializationPlan(function, ImmutableArray<BoundExpression>.Empty, Empty(), new BoundBlockStatement(null, statements.ToImmutable()));
            }
        }

        foreach (var type in program.Interfaces)
        {
            if (!HasRequest(type.StaticFieldInitializers.Values))
            {
                continue;
            }

            var function = OwnerFunction(program, type, ImmutableArray<ParameterSymbol>.Empty, isStatic: true);
            var constants = type.ConstFields.Where(f => ConstantFieldMetadataEmitter.RequiresRuntimeInitialization(f.ConstantValue))
                .Select(field => (BoundStatement)new BoundExpressionStatement(
                    null,
                    new BoundFieldAssignmentExpression(null, field, type, new BoundLiteralExpression(null, field.ConstantValue, field.Type))));
            var statements = constants.Concat(type.StaticFields.Where(type.StaticFieldInitializers.ContainsKey)
                .Select(field => (BoundStatement)new BoundExpressionStatement(
                    type.StaticFieldInitializers[field].Syntax,
                    new BoundFieldAssignmentExpression(type.StaticFieldInitializers[field].Syntax, field, type, type.StaticFieldInitializers[field]))))
                .ToImmutableArray();
            plans[(type, true)] = new BoundInitializationPlan(function, ImmutableArray<BoundExpression>.Empty, Empty(), new BoundBlockStatement(null, statements));
        }

        if (plans.Count == program.Initializers.Count)
        {
            return program;
        }

        return new BoundProgram(
            program.EntryPointPackage,
            program.Packages,
            program.Diagnostics,
            functions.ToImmutable(),
            program.EntryPoint,
            program.Statement,
            program.Structs,
            program.Interfaces,
            program.Enums,
            program.Globals,
            program.Delegates)
        {
            Initializers = plans.ToImmutable(),
            Imports = program.Imports,
            FriendAssemblies = program.FriendAssemblies,
            AssemblyAttributes = program.AssemblyAttributes,
            ModuleAttributes = program.ModuleAttributes,
        };
    }

    private static BoundInitializationPlan InstancePlan(
        StructSymbol owner, FunctionSymbol function, ImmutableArray<BoundExpression> arguments, BoundBlockStatement body, bool primaryStores)
    {
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var receiver = Invariant.Required(function.ThisParameter, "instance initialization has its constructor receiver");
        if (primaryStores)
        {
            foreach (var parameter in function.Parameters)
            {
                ReflectionMetadataEmitter.TryGetPrimaryCtorTargetField(owner, parameter.Name, out var field);
                statements.Add(new BoundExpressionStatement(null, new BoundFieldAssignmentExpression(
                    null,
                    receiver,
                    owner,
                    Invariant.Required(field, "primary constructor parameters have corresponding fields"),
                    new BoundVariableExpression(null, parameter))));
            }
        }

        foreach (var field in owner.Fields)
        {
            if (owner.InstanceFieldInitializers.TryGetValue(field, out var expression))
            {
                statements.Add(new BoundExpressionStatement(
                    expression.Syntax,
                    new BoundFieldAssignmentExpression(expression.Syntax, receiver, owner, field, expression)));
            }
        }

        statements.AddRange(body.Statements);
        return new BoundInitializationPlan(function, arguments, Empty(), new BoundBlockStatement(body.Syntax, statements.ToImmutable()));
    }

    private static FunctionSymbol OwnerFunction(BoundProgram program, TypeSymbol owner, ImmutableArray<ParameterSymbol> parameters, bool isStatic)
    {
        var packageName = owner switch
        {
            StructSymbol type => type.PackageName,
            InterfaceSymbol type => type.PackageName,
            _ => program.PackageName,
        };
        var package = program.Packages.FirstOrDefault(candidate => candidate.Name == packageName) ?? program.EntryPointPackage;
        var function = new FunctionSymbol(
            isStatic ? "<>initializer" : "<>constructor",
            parameters,
            TypeSymbol.Void,
            declaration: null,
            package,
            Accessibility.Private,
            receiverType: isStatic ? null : owner)
        {
            StaticOwnerType = isStatic ? owner : null,
        };
        return function;
    }

    private static BoundBlockStatement Empty() => new(null, ImmutableArray<BoundStatement>.Empty);

    private static bool HasRequest(System.Collections.Generic.IEnumerable<BoundExpression> expressions)
        => expressions.Any(expression => HasRequest(new BoundExpressionStatement(expression.Syntax, expression)));

    private static bool HasRequest(BoundStatement statement)
    {
        var finder = new RequestFinder();
        finder.Visit(statement);
        return finder.Found;
    }

    private sealed class RequestFinder : BoundTreeWalker
    {
        internal bool Found { get; private set; }

        public override void VisitExpression(BoundExpression? node)
        {
            Found |= node is BoundManagedReferenceExpression;
            if (node is BoundFunctionLiteralExpression literal)
            {
                Visit(literal.Body);
            }

            base.VisitExpression(node);
        }
    }
}
