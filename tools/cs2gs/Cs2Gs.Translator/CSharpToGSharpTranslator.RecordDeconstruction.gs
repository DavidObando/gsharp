package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import Microsoft.CodeAnalysis.Operations
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Linq

partial class CSharpToGSharpTranslator {
    private partial class DeclarationVisitor {
        private let recordPatternCaches Dictionary[
            SyntaxNode,
            List[(Method IMethodSymbol, Flag string, Values string, Type ITypeSymbol)]
        ] =
        Dictionary[SyntaxNode, List[(Method IMethodSymbol, Flag string, Values string, Type ITypeSymbol)]]()

        private func RecordDeconstructionAdapterName(method IMethodSymbol) string {
            let original = method.OriginalDefinition
            let overload = original
                .ContainingType
                .GetMembers("Deconstruct")
                .OfType[IMethodSymbol]()
                .OrderBy((candidate IMethodSymbol) -> candidate.ToDisplayString(), StringComparer.Ordinal)
                .TakeWhile((candidate IMethodSymbol) -> !SymbolEqualityComparer.Default.Equals(candidate, original))
                .Count()
            let stem = "__cs2gsRecordDeconstruct_" +
                original
                .ContainingType
                .Name +
                "_" +
                original
                .Parameters
                .Length
                .ToString(CultureInfo.InvariantCulture) +
                "_" +
                overload.ToString(CultureInfo.InvariantCulture)
            let taken = HashSet[string](
                ReceiverTypeHierarchy(original.ContainingType).SelectMany(
                    (owner INamedTypeSymbol) -> owner.GetMembers()
                )
                    .Select((member ISymbol) -> this.nameAllocator.GetName(member)!!),
                StringComparer.Ordinal
            )
            var name = stem
            for var suffix = 2; taken.Contains(name); suffix++ {
                name = stem + "_" + suffix.ToString(CultureInfo.InvariantCulture)
            }
            return name
        }

        private func BuildRecordDeconstructionAdapter(method IMethodSymbol) MethodDeclaration? {
            // A method adapter adds no equality storage or printable property to the data type.
            if !EmittedNameAllocator.IsUserRecordDeconstruct(method) ||
                method.IsStatic ||
                !method.ReturnsVoid ||
                method.Arity != 0 ||
                method
                .Parameters
                .Length < 2 ||
                method
                .Parameters
                .Any((parameter IParameterSymbol) -> parameter.RefKind != RefKind.Out) {
                return nil
            }
            let statements = List[GStatement]()
            let arguments = List[GExpression]()
            let elements = List[GExpression]()
            let types = List[GTypeReference]()
            var receiver GExpression = ThisExpression()
            if method.ContainingType.IsValueType {
                // C# deconstruction calls a struct receiver copy; an explicit Deconstruct call can mutate the original.
                statements.Add(LocalDeclarationStatement(BindingKind.Var, "receiver", initializer: receiver))
                receiver = IdentifierExpression("receiver")
            }
            for var i = 0; i < method.Parameters.Length; i++ {
                let parameter = method.Parameters[i]
                if parameter.Type.IsRefLikeType {
                    this.context.ReportUnsupported(
                        method.DeclaringSyntaxReferences[0].GetSyntax(),
                        "record Deconstruct outputs with ref-like types cannot use a tuple adapter."
                    )
                    return nil
                }
                let type = this.typeMapper.Map(parameter.Type, this.context, location: nil)
                let name = "component" + i.ToString(CultureInfo.InvariantCulture)
                statements.Add(LocalDeclarationStatement(BindingKind.Var, name, type))
                let element = IdentifierExpression(name)
                arguments.Add(UnaryExpression("&", element))
                elements.Add(element)
                types.Add(type!!)
            }
            statements.Add(
                ExpressionStatement(
                    InvocationExpression(
                        MemberAccessExpression(receiver, this.EmittedName(method, method.Name)),
                        arguments
                    )
                )
            )
            statements.Add(ReturnStatement(TupleLiteralExpression(elements)))
            return MethodDeclaration(
                RecordDeconstructionAdapterName(method),
                Array.Empty[Parameter](),
                TupleTypeReference(types),
                BlockStatement(statements),
                visibility: MapVisibility(method, this.context, method.DeclaringSyntaxReferences[0].GetSyntax())
            )
        }

        private func RewriteRecordDeconstruction(value GExpression?, method IMethodSymbol?) GExpression? {
            if !EmittedNameAllocator.IsUserRecordDeconstruct(method) {
                return value
            }
            return InvocationExpression(
                MemberAccessExpression(value, RecordDeconstructionAdapterName(method!!)),
                Array.Empty[GExpression]()
            )
        }

        private func GetDeconstructionInfo(right ExpressionSyntax?) DeconstructionInfo {
            return if right?.Parent is AssignmentExpressionSyntax assignment {
                this.context.SemanticModel.GetDeconstructionInfo(assignment)
            } else {
                default(DeconstructionInfo)
            }
        }

        private func NestedDeconstructionInfo(info DeconstructionInfo, index int32) DeconstructionInfo ->
        if index < info.Nested.Length {
            info.Nested[index]
        } else {
            default(DeconstructionInfo)
        }

        private func UserRecordPatternDeconstruct(recursive RecursivePatternSyntax) IMethodSymbol? {
            if recursive.PositionalPatternClause != nil &&
                this
                .context
                .SemanticModel
                .GetOperation(recursive) is IRecursivePatternOperation operation &&
                operation.DeconstructSymbol is IMethodSymbol method &&
                EmittedNameAllocator.IsUserRecordDeconstruct(method) {
                return method
            }
            return nil
        }

        private func RecordDeconstructionRunsUserCode(info DeconstructionInfo) bool ->
        EmittedNameAllocator.IsUserRecordDeconstruct(info.Method) ||
            (!info.Nested.IsDefaultOrEmpty && info.Nested.Any(this.RecordDeconstructionRunsUserCode))

        private func RecordPatternNeedsDeconstruction(recursive RecursivePatternSyntax) bool ->
        recursive.PositionalPatternClause!!.Subpatterns.Any(
            (subpattern SubpatternSyntax) -> subpattern.Pattern is not DiscardPatternSyntax &&
                subpattern.Pattern is not VarPatternSyntax{Designation: DiscardDesignationSyntax}
        )

        private func TranslateRecordPositionalPatternTest(
            receiver GExpression?,
            recursive RecursivePatternSyntax,
            method IMethodSymbol
        ) GExpression {
            let subpatterns = recursive.PositionalPatternClause!!.Subpatterns
            // C# omits a pattern's Deconstruct call when every output is discarded.
            if !this.RecordPatternNeedsDeconstruction(recursive) {
                return LiteralExpression.Bool(true)
            }
            let call = this.RewriteRecordDeconstruction(receiver, method)
            let tupleType = this
                .context
                .Compilation
                .CreateTupleTypeSymbol(
                method.Parameters.Select((parameter IParameterSymbol) -> parameter.Type).ToImmutableArray()
            )
            let BuildTest = func (tuple GExpression) GExpression {
                var test GExpression = LiteralExpression.Bool(true)
                for var i = 0; i < subpatterns.Count; i++ {
                    let member = MemberAccessExpression(tuple, "Item" + (i + 1).ToString(CultureInfo.InvariantCulture))
                    let component = this.TranslatePatternTest(
                        member,
                        subpatterns[i].Pattern,
                        method.Parameters[i].Type,
                        isNestedPatternMember: true
                    )
                    test = BinaryExpression(test, "&&", component)
                }
                return test
            }
            let declarations = this.state.ShortCircuitSpillDeclarations ?? this.state.PendingSpillPrologue
            let owner = this.RecordPatternDecisionOwner(recursive)
            if owner != nil && declarations != nil {
                if !this.recordPatternCaches.TryGetValue(owner, out var caches) {
                    caches = List[(Method IMethodSymbol, Flag string, Values string, Type ITypeSymbol)]()
                    this.recordPatternCaches.Add(owner, caches)
                }
                var cache = caches.FirstOrDefault(
                    (entry(Method IMethodSymbol, Flag string, Values string, Type ITypeSymbol)) ->
                    SymbolEqualityComparer.Default.Equals(entry.Method, method)
                )
                if cache.Method == nil {
                    let flag = this.AllocateSynthesizedLocalName("deconstructed", recursive)
                    let values = this.AllocateSynthesizedLocalName("components", recursive)
                    cache = (method, flag, values, tupleType)
                    caches.Add(cache)
                    if owner is IsPatternExpressionSyntax {
                        declarations.Add(
                            LocalDeclarationStatement(
                                BindingKind.Var,
                                flag,
                                NamedTypeReference("bool"),
                                LiteralExpression.Bool(false)
                            )
                        )
                        declarations.Add(
                            LocalDeclarationStatement(
                                BindingKind.Var,
                                values,
                                this.typeMapper.Map(tupleType, this.context, location: nil)
                            )
                        )
                    }
                }
                let local = IdentifierExpression(cache.Values)
                let flag = IdentifierExpression(cache.Flag)
                return BlockExpression(
                    []GStatement{
                        IfStatement(
                            UnaryExpression("!", flag),
                            BlockStatement(
                                []GStatement{
                                    AssignmentStatement(local, call),
                                    AssignmentStatement(flag, LiteralExpression.Bool(true))
                                }
                            )
                        )
                    },
                    BuildTest(local)
                )
            }
            if !recursive.PositionalPatternClause!!.Subpatterns.Any(
                (subpattern SubpatternSyntax) -> PatternIntroducesBinding(subpattern.Pattern)
            ) {
                return this.BindPatternMemberOnce(call, BuildTest)
            }
            if declarations == nil {
                this.context.ReportUnsupported(
                    recursive,
                    "record positional pattern bindings require a declaration seam."
                )
                return LiteralExpression.Bool(false)
            }
            // Store the outputs inside the guarded test so bindings read them without repeating the call.
            return this.StorePatternMemberOnce(call, tupleType, false, declarations, BuildTest)
        }

        private func RecordPatternDecisionOwner(recursive RecursivePatternSyntax) SyntaxNode? {
            var pattern SyntaxNode = recursive
            while pattern.Parent is ParenthesizedPatternSyntax ||
                pattern.Parent is BinaryPatternSyntax ||
                pattern.Parent is UnaryPatternSyntax {
                pattern = pattern.Parent!!
            }
            return switch pattern.Parent {
                case arm is SwitchExpressionArmSyntax when arm.Pattern == pattern: arm.Parent
                case label is CasePatternSwitchLabelSyntax when label.Pattern == pattern: label.Parent?.Parent
                case expression is IsPatternExpressionSyntax when expression.Pattern == pattern: expression
                default: nil
            }
        }

        private func ResetRecordPatternCaches(owner SyntaxNode, subject GExpression?) GExpression? {
            if !this.recordPatternCaches.TryGetValue(owner, out var caches) {
                return subject
            }
            let resets = List[GStatement]()
            for cache in caches {
                resets.Add(AssignmentStatement(IdentifierExpression(cache.Flag), LiteralExpression.Bool(false)))
            }
            return BlockExpression(resets, subject)
        }

        private func RecordPatternCacheDeclarations(owner SyntaxNode) List[GStatement] {
            let declarations = List[GStatement]()
            if this.recordPatternCaches.TryGetValue(owner, out var caches) {
                for cache in caches {
                    declarations.Add(
                        LocalDeclarationStatement(
                            BindingKind.Var,
                            cache.Flag,
                            NamedTypeReference("bool"),
                            LiteralExpression.Bool(false)
                        )
                    )
                    declarations.Add(
                        LocalDeclarationStatement(
                            BindingKind.Var,
                            cache.Values,
                            this.typeMapper.Map(cache.Type, this.context, location: nil)
                        )
                    )
                }
            }
            return declarations
        }

        private func WrapRecordPatternDecision(owner SyntaxNode, expression GExpression?) GExpression? {
            let declarations = this.RecordPatternCacheDeclarations(owner)
            return if declarations.Count == 0 {
                expression
            } else {
                BlockExpression(declarations, expression)
            }
        }

        private func TranslateRecordRecursivePattern(
            recursive RecursivePatternSyntax,
            receiver GExpression?,
            bindings List[(Symbol ISymbol, Replacement GExpression)],
            usedDesignators HashSet[string]?,
            guards List[GExpression],
            mutableBindings List[(Symbol ILocalSymbol, MatchedValue GExpression)]?
        ) GPattern {
            let operation = cast[IRecursivePatternOperation](this.context.SemanticModel.GetOperation(recursive))
            let designator = if recursive.Designation is SingleVariableDesignationSyntax variable {
                this.EmittedName(variable, variable.Identifier)!!
            } else {
                this.AllocateSynthesizedLocalName("record", recursive)
            }
            usedDesignators?.Add(designator)
            this.AddTypedSubpatternGuard(
                () -> this.TranslateRecursivePatternTest(
                    IdentifierExpression(designator),
                    recursive,
                    receiverType: operation.MatchedType,
                    receiverAlreadyMatched: true
                ),
                bindings,
                guards,
                mutableBindings
            )
            return TypePattern(
                designator,
                this.typeMapper.Map(operation.MatchedType, this.context, location: nil)!!,
                designationAfterType: true
            )
        }
    }
}
