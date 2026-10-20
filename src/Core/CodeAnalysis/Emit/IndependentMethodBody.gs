package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Linq
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335

/// A method-owned instruction buffer. Metadata and debug documents are committed only by the coordinator.
internal class IndependentMethodBody {
    private let body BoundBlockStatement
    private let function FunctionSymbol
    private let emitter MethodBodyEmitter
    private let points List[(Offset int32, Syntax SyntaxNode?)] = List[(Offset int32, Syntax SyntaxNode?)]()

    init(outer ReflectionMetadataEmitter, function FunctionSymbol, body BoundBlockStatement) {
        this.body = body
        this.function = function
        Il = InstructionEncoder(BlobBuilder(), ControlFlowBuilder())
        Session = ReflectionMetadataEmitter.MethodBodyEmitSession(outer, Il)
        let parameters = Dictionary[ParameterSymbol, int32]()
        var next = 0
        if function.IsInstanceMethod {
            parameters[Invariant.Required(function.ThisParameter, "an instance method has a receiver")] = next++
        }
        for parameter in function.EmittedParameters {
            if !object.ReferenceEquals(parameter, function.ThisParameter) {
                parameters[parameter] = next++
            }
        }
        let captureSequencePoints = outer.emitCtx.Pdb != nil
        this.emitter = Session.CreateEmitter(
            parameters,
            isolated: true,
            recordLocalSequencePoint: (offset int32, syntax SyntaxNode?) -> {
                if captureSequencePoints {
                    this.points.Add((offset, syntax))
                }
            }
        )
    }

    prop Il InstructionEncoder {
        get;
    }
    prop Session ReflectionMetadataEmitter.MethodBodyEmitSession {
        get;
    }
    prop MaxStack int32 {
        get;
        private set;
    }
    prop BufferedSequencePointCount int32 -> this.points.Count

    func Emit() {
        try {
            Session.CollectConstValues(this.body)
            Session.PlanIndependent(this.body)
            this.emitter.EmitMethodBody(this.body, alwaysAppendRet: this.function.Type == TypeSymbol.Void)
            MaxStack = MaxStackTracker.ComputeMaxStack(Il)
        } catch (ex Exception) when !(ex is EmitDiagnosticException) &&
            !(ex is OutOfMemoryException) &&
            !(ex is StackOverflowException) {
            EmitDiagnosticException.Wrap(
                this.emitter.CurrentAnchor ?? this.function.Declaration ?? this.body.Syntax,
                ex
            )
        }
    }

    func ResolveSequencePoints(pdb PortablePdbEmitter?) IReadOnlyList[SequencePoint] {
        let result = List[SequencePoint]()
        if pdb == nil {
            return result
        }
        for (offset, syntax) in this.points {
            if syntax == nil || syntax.Location.Text == nil {
                result.Add(SequencePoint.Hidden(offset, default(DocumentHandle)))
                continue
            }
            let location = syntax.Location
            result.Add(
                SequencePoint(
                    offset,
                    pdb.GetOrAddDocument(syntax.SyntaxTree),
                    location.StartLine + 1,
                    location.StartCharacter + 1,
                    location.EndLine + 1,
                    location.EndCharacter + 1
                )
            )
        }
        return result
    }

    shared {
        /// Unknown nodes stay on the coordinator. This proof excludes token-producing operations and shared synthesis.
        func CanPrepare(function FunctionSymbol, body BoundBlockStatement) bool -> !function.IsPInvoke &&
            !function.IsAbstract &&
            !function.IsAsyncOrSuspending &&
            function.StateMachineType == nil &&
            function
            .TypeParameters
            .IsDefaultOrEmpty &&
            function.ReturnRefKind == RefKind.None &&
            (Primitive(function.Type) || function.Type == TypeSymbol.Void) &&
            function
            .EmittedParameters
            .All(
            (p ParameterSymbol) ->
            object.ReferenceEquals(p, function.ThisParameter) || Primitive(p.Type) && p.RefKind == RefKind.None
        ) &&
            (function.Type == TypeSymbol.Void || body.Statements.LastOrDefault() is BoundReturnStatement) &&
            IsLocal(body)

        func IsLocal(node BoundNode) bool {
            if node is BoundExpression expression && !Primitive(expression.Type) && expression.Type != TypeSymbol.Void {
                return false
            }
            return switch node {
                case block is BoundBlockStatement: block.Statements.All((s BoundStatement) -> IsLocal(s))
                case declaration is BoundVariableDeclaration:
                Variable(declaration.Variable) && declaration.Initializer != nil && IsLocal(declaration.Initializer)
                case statement is BoundExpressionStatement: IsLocal(statement.Expression)
                case ret is BoundReturnStatement: !ret.IsRef && (ret.Expression == nil || IsLocal(ret.Expression))
                case BoundLabelStatement: true
                case BoundGotoStatement: true
                case branch is BoundConditionalGotoStatement: IsLocal(branch.Condition)
                case conditional is BoundIfStatement:
                IsLocal(conditional.Condition) &&
                    IsLocal(conditional.ThenStatement) &&
                    (conditional.ElseStatement == nil || IsLocal(conditional.ElseStatement))
                case loop is BoundForInfiniteStatement: IsLocal(loop.Body)
                case loop is BoundForEllipsisStatement:
                Variable(loop.Variable) && IsLocal(loop.LowerBound) && IsLocal(loop.UpperBound) && IsLocal(loop.Body)
                case literal is BoundLiteralExpression: Primitive(literal.Type)
                case variable is BoundVariableExpression:
                Variable(variable.Variable) &&
                    (variable.NarrowedType == nil || variable.NarrowedType == variable.Variable.Type)
                case assignment is BoundAssignmentExpression: Variable(assignment.Variable) &&
                    IsLocal(assignment.Expression)
                case unary is BoundUnaryExpression: unary
                    .Op
                    .Kind != BoundUnaryOperatorKind.NullAssertion &&
                    IsLocal(unary.Operand)
                case binary is BoundBinaryExpression: !binary
                    .Op
                    .IsDelegateCombination &&
                    IsLocal(binary.Left) &&
                    IsLocal(binary.Right)
                default: false
            }
        }

        private func Variable(variable VariableSymbol) bool -> Primitive(variable.Type) &&
            (
            variable is ParameterSymbol{RefKind: RefKind.None} || variable is LocalVariableSymbol{RefKind: RefKind.None}
        )

        private func Primitive(type TypeSymbol) bool -> type == TypeSymbol.Bool ||
            type == TypeSymbol.Int8 ||
            type == TypeSymbol.UInt8 ||
            type == TypeSymbol.Int16 ||
            type == TypeSymbol.UInt16 ||
            type == TypeSymbol.Char ||
            type == TypeSymbol.Int32 ||
            type == TypeSymbol.UInt32 ||
            type == TypeSymbol.Int64 ||
            type == TypeSymbol.UInt64 ||
            type == TypeSymbol.NInt ||
            type == TypeSymbol.NUInt ||
            type == TypeSymbol.Float32 ||
            type == TypeSymbol.Float64
    }
}
