// <copyright file="InitializationPlanner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Lowering.Iterators
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

internal shared class InitializationPlanner {
    private class PrimaryStorageRewriter : HoistedFieldRewriter {
        private let propertyMap Dictionary[VariableSymbol, PropertySymbol]

        internal init(
            owner StructSymbol,
            receiver ParameterSymbol,
            fields Dictionary[VariableSymbol, FieldSymbol],
            properties Dictionary[VariableSymbol, PropertySymbol]
        ) : base(owner, receiver, fields) {
            this.propertyMap = properties
        }

        protected override func RewriteVariableExpression(node BoundVariableExpression) BoundExpression {
            if this.propertyMap.TryGetValue(node.Variable, out var property) {
                return BoundPropertyAccessExpression(
                    node.Syntax,
                    BoundVariableExpression(nil, this.thisParameter),
                    this.smClass,
                    property,
                    node.NarrowedType
                )
            }
            return base.RewriteVariableExpression(node)
        }

        protected override func RewriteFunctionLiteralExpression(node BoundFunctionLiteralExpression) BoundExpression {
            let body = cast[BoundBlockStatement](this.RewriteStatement(node.Body))
            let captures = node
                .CapturedVariables
                .Where((variable VariableSymbol) -> !this.IsStoredPrimaryInput(variable))
                .ToImmutableArray()
                .ToBuilder()
            if node.CapturedVariables.Any(this.IsStoredPrimaryInput) && !captures.Contains(this.thisParameter) {
                captures.Add(this.thisParameter)
            }
            return if object.ReferenceEquals(body, node.Body) && captures.SequenceEqual(node.CapturedVariables) {
                node
            } else {
                BoundFunctionLiteralExpression(
                    node.Syntax,
                    node.Function,
                    node.FunctionType,
                    body,
                    captures.ToImmutable()
                )
            }
        }

        protected override func RewriteLocalFunctionDeclaration(node BoundLocalFunctionDeclaration) BoundStatement {
            let literal = cast[BoundFunctionLiteralExpression](this.RewriteFunctionLiteralExpression(node.Literal))
            return if object.ReferenceEquals(literal, node.Literal) {
                node
            } else {
                BoundLocalFunctionDeclaration(node.Syntax, literal)
            }
        }

        private func IsStoredPrimaryInput(variable VariableSymbol) bool -> this.fieldMap.ContainsKey(variable) ||
            this
            .propertyMap
            .ContainsKey(variable)
    }

    private class RequestFinder : BoundTreeWalker {
        internal prop Found bool {
            get;
            private set;
        }

        override func VisitExpression(node BoundExpression?) {
            Found |= node is BoundManagedReferenceExpression ||
                node is BoundStructLiteralExpression &&
                node
                .StructType
                .HasPrimaryConstructor == true &&
                node
                .StructType
                .NeedsSynthesizedValueStructDefaultCtor == true
            if node is BoundFunctionLiteralExpression literal {
                Visit(literal.Body)
            }
            base.VisitExpression(node)
        }
    }

    internal func Prepare(program BoundProgram) BoundProgram {
        if !program.Initializers.IsEmpty {
            return program
        }
        let plans = program.Initializers.ToBuilder()
        let functions = program.Functions.ToBuilder()
        for type in program.Structs {
            if type.ClrType == nil &&
                type.IsData &&
                !type.IsClass &&
                !type.IsInline &&
                !type
                .NeedsSynthesizedValueStructDefaultCtor {
                let methods = type.StaticMethods.ToBuilder()
                for field in type.Fields {
                    if !(field.Declaration is FieldDeclarationSyntax{Initializer: not nil}) ||
                        !type
                        .InstanceFieldInitializers
                        .TryGetValue(field, out var expression) {
                        continue
                    }
                    let name = ImportedAssemblySemantics.GetFieldInitializerMethodName(field.Name)
                    // Imported literals need the expression, not an authored constructor
                    // or an initializer for a field that the literal explicitly supplies.
                    let function = methods.FirstOrDefault((method FunctionSymbol) -> method.Name == name) ??
                        FunctionSymbol(
                        name,
                        ImmutableArray[ParameterSymbol].Empty,
                        field.Type,
                        declaration: nil,
                        program.Packages.First((package_ PackageSymbol) -> package_.Name == type.PackageName),
                        Accessibility.Public
                    ){IsStatic = true, IsSpecialName = true, StaticOwnerType = type}
                    if functions.ContainsKey(function) {
                        continue
                    }
                    if !methods.Contains(function) {
                        methods.Add(function)
                    }
                    functions.Add(
                        function,
                        BoundBlockStatement(
                            expression.Syntax,
                            ImmutableArray.Create[BoundStatement](BoundReturnStatement(expression.Syntax, expression))
                        )
                    )
                }
                type.SetStaticMethods(methods.ToImmutable())
            }
            let fields = type.InstanceFieldInitializers.Values
            let primary = type.BaseConstructorInitializer?.Arguments ?? ImmutableArray[BoundExpression].Empty
            if (
                type.ExplicitConstructor == nil ||
                    type.HasPrimaryConstructor ||
                    type.NeedsSynthesizedValueStructDefaultCtor
            ) &&
                (type.NeedsSynthesizedValueStructDefaultCtor || HasRequest(fields.Concat(primary))) {
                let function = OwnerFunction(program, type, type.PrimaryConstructorParameters, isStatic: false)
                plans[(type, false)] = InstancePlan(type, function, primary, Empty(), primaryStores: true)
            }
            for constructor in type.ExplicitConstructors.Where(
                (c ConstructorSymbol) -> !c.IsSynthesizedFromPrimaryConstructor
            ) {
                if !functions.TryGetValue(constructor.Function, out var body) {
                    continue
                }
                let arguments = constructor.BaseInitializer?.Arguments ?? ImmutableArray[BoundExpression].Empty
                if !type.HasPrimaryConstructor && !HasRequest(fields.Concat(arguments)) && !HasRequest(body) {
                    continue
                }
                plans[(constructor.Function, false)] = if constructor.IsConvenience {
                    BoundInitializationPlan(constructor.Function, arguments, Empty(), body)
                } else {
                    InstancePlan(type, constructor.Function, arguments, body, primaryStores: false)
                }
                functions.Remove(constructor.Function)
            }
            let staticBody = BoundBlockStatement(nil, type.StaticInitializerStatements)
            if HasRequest(type.StaticFieldInitializers.Values) || HasRequest(staticBody) {
                let function = OwnerFunction(program, type, ImmutableArray[ParameterSymbol].Empty, isStatic: true)
                let statements = ImmutableArray.CreateBuilder[BoundStatement]()
                for field in type.ConstFields.Where(
                    (f FieldSymbol) -> ConstantFieldMetadataEmitter.RequiresRuntimeInitialization(f.ConstantValue)
                ) {
                    statements.Add(
                        BoundExpressionStatement(
                            nil,
                            BoundFieldAssignmentExpression(
                                nil,
                                nil,
                                type,
                                field,
                                BoundLiteralExpression(nil, field.ConstantValue, field.Type)
                            )
                        )
                    )
                }
                for field in type.StaticFields {
                    if type.StaticFieldInitializers.TryGetValue(field, out var initializer) {
                        statements.Add(
                            BoundExpressionStatement(
                                initializer.Syntax,
                                BoundFieldAssignmentExpression(initializer.Syntax, nil, type, field, initializer)
                            )
                        )
                    }
                }
                statements.AddRange(type.StaticInitializerStatements)
                plans[(type, true)] = BoundInitializationPlan(
                    function,
                    ImmutableArray[BoundExpression].Empty,
                    Empty(),
                    BoundBlockStatement(nil, statements.ToImmutable())
                )
            }
        }
        for type in program.Interfaces {
            if !HasRequest(type.StaticFieldInitializers.Values) {
                continue
            }
            let function = OwnerFunction(program, type, ImmutableArray[ParameterSymbol].Empty, isStatic: true)
            let constants = type
                .ConstFields
                .Where((f FieldSymbol) -> ConstantFieldMetadataEmitter.RequiresRuntimeInitialization(f.ConstantValue))
                .Select(
                (field FieldSymbol) -> cast[BoundStatement](
                    BoundExpressionStatement(
                        nil,
                        BoundFieldAssignmentExpression(
                            nil,
                            field,
                            type,
                            BoundLiteralExpression(nil, field.ConstantValue, field.Type)
                        )
                    )
                )
            )
            let statements = constants.Concat(
                type
                    .StaticFields
                    .Where((field FieldSymbol) -> type.StaticFieldInitializers.ContainsKey(field))
                    .Select(
                    (field FieldSymbol) -> cast[BoundStatement](
                        BoundExpressionStatement(
                            type.StaticFieldInitializers[field].Syntax,
                            BoundFieldAssignmentExpression(
                                type.StaticFieldInitializers[field].Syntax,
                                field,
                                type,
                                type.StaticFieldInitializers[field]
                            )
                        )
                    )
                )
            )
                .ToImmutableArray()
            plans[(type, true)] = BoundInitializationPlan(
                function,
                ImmutableArray[BoundExpression].Empty,
                Empty(),
                BoundBlockStatement(nil, statements)
            )
        }
        if plans.Count == program.Initializers.Count && functions.Count == program.Functions.Count {
            return program
        }
        return BoundProgram(
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
            program.Delegates
        ){
            Initializers = plans.ToImmutable(),
            Imports = program.Imports,
            FriendAssemblies = program.FriendAssemblies,
            AssemblyAttributes = program.AssemblyAttributes,
            ModuleAttributes = program.ModuleAttributes,
            NativeProtocols = program.NativeProtocols
        }
    }

    private func InstancePlan(
        owner StructSymbol,
        function FunctionSymbol,
        arguments ImmutableArray[BoundExpression],
        body BoundBlockStatement,
        primaryStores bool
    ) BoundInitializationPlan {
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        let receiver = Invariant.Required(
            function.ThisParameter,
            "instance initialization has its constructor receiver",
            expression: "function.ThisParameter"
        )
        // Authored constructors have their own parameter scope; declaration
        // initializers read primary inputs from the already-owned storage.
        var storedPrimaryInputs PrimaryStorageRewriter? = nil
        if !primaryStores && owner.HasPrimaryConstructor {
            let fields = Dictionary[VariableSymbol, FieldSymbol]()
            let properties = Dictionary[VariableSymbol, PropertySymbol]()
            for parameter in owner.PrimaryConstructorParameters {
                if ReflectionMetadataEmitter.TryGetPrimaryCtorTargetField(owner, parameter.Name, out var field) {
                    fields.Add(parameter, field)
                    continue
                }
                TypeMemberModel.TryGetProperty(owner, parameter.Name, out var property)
                properties.Add(
                    parameter,
                    Invariant.Required(
                        property,
                        "a storage-free primary parameter has a computed positional property",
                        expression: "property"
                    )
                )
            }
            storedPrimaryInputs = PrimaryStorageRewriter(owner, receiver, fields, properties)
        }
        if primaryStores {
            for parameter in function.Parameters {
                if !ReflectionMetadataEmitter.TryGetPrimaryCtorTargetField(owner, parameter.Name, out var field) {
                    continue
                }
                statements.Add(
                    BoundExpressionStatement(
                        nil,
                        BoundFieldAssignmentExpression(
                            nil,
                            receiver,
                            owner,
                            Invariant.Required(
                                field,
                                "primary constructor parameters have corresponding fields",
                                expression: "field"
                            ),
                            BoundVariableExpression(nil, parameter)
                        )
                    )
                )
            }
        }
        for field in owner.Fields {
            if owner.InstanceFieldInitializers.TryGetValue(field, out var expression) {
                let assignment = BoundExpressionStatement(
                    expression.Syntax,
                    BoundFieldAssignmentExpression(expression.Syntax, receiver, owner, field, expression)
                )
                statements.Add(storedPrimaryInputs?.RewriteStatement(assignment) ?? assignment)
            }
        }
        statements.AddRange(body.Statements)
        return BoundInitializationPlan(
            function,
            arguments,
            Empty(),
            BoundBlockStatement(body.Syntax, statements.ToImmutable())
        )
    }

    private func OwnerFunction(
        program BoundProgram,
        owner TypeSymbol,
        parameters ImmutableArray[ParameterSymbol],
        isStatic bool
    ) FunctionSymbol {
        let packageName = switch owner {
            case type is StructSymbol: type.PackageName
            case type is InterfaceSymbol: type.PackageName
            default: program.PackageName
        }
        let package_ = program.Packages.FirstOrDefault((candidate PackageSymbol) -> candidate.Name == packageName) ??
            program.EntryPointPackage
        let function = FunctionSymbol(
            if isStatic {
                "<>initializer"
            } else {
                "<>constructor"
            },
            parameters,
            TypeSymbol.Void,
            declaration: nil,
            package_,
            Accessibility.Private,
            receiverType: if isStatic {
                default(TypeSymbol?)
            } else {
                owner
            }
        ){
            StaticOwnerType = if isStatic {
                owner
            } else {
                default(TypeSymbol?)
            }
        }
        return function
    }

    private func Empty() BoundBlockStatement -> BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)

    private func HasRequest(expressions IEnumerable[BoundExpression]) bool -> expressions.Any(
        (expression BoundExpression) -> HasRequest(BoundExpressionStatement(expression.Syntax, expression))
    )

    private func HasRequest(statement BoundStatement) bool {
        let finder = RequestFinder()
        finder.Visit(statement)
        return finder.Found
    }
}
