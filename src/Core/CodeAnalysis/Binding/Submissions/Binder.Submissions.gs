// <copyright file="Binder.Submissions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq

/// Interactive-submission hooks and trailing-value capture on (cref:Binder) (ADR-0156, ADR-0212 slice S8).
partial class Binder {
    private func TryResolvePriorCellType(
        $scope BoundScope,
        name string,
        preferredArity int32,
        @NotNullWhen(true) out type TypeSymbol?
    ) bool -> SubmissionBinding.TryResolveType($scope, name, preferredArity, out type)

    shared {
        /// Binds a set of syntax trees to the previous global scope, with full
        /// control over implicit-import seeding, the active preprocessor symbol
        /// set, whether the compilation is a library, and — ADR-0156 Phase 2 —
        /// optional interactive submission options that bind prior REPL
        /// submissions as metadata-backed imports.
        /// @param previous The previous global scope.
        /// @param syntaxTrees The new syntax trees.
        /// @param references The reference resolver; `null` selects (cref:ReferenceResolver.Default).
        /// @param implicitSystemImport When `true`, an implicit `import System` is seeded before user imports
        /// are processed.
        /// @param preprocessorSymbols The active preprocessor symbol set; `null` means the empty set.
        /// @param isLibrary When `true`, the compilation produces a library and top-level statements are
        /// reported as `GS0285` at the first global statement.
        /// @param submission Interactive submission options, or `null` for an ordinary compilation.
        /// @returns The new chained bound global scope.
        func BindGlobalScope(
            previous BoundGlobalScope?,
            syntaxTrees ImmutableArray[SyntaxTree],
            references ReferenceResolver?,
            implicitSystemImport bool,
            preprocessorSymbols ImmutableHashSet[string]?,
            isLibrary bool,
            submission SubmissionBindingOptions?
        ) BoundGlobalScope -> BindGlobalScopeWithRoot(
            previous,
            syntaxTrees,
            references,
            implicitSystemImport,
            preprocessorSymbols,
            isLibrary,
            if submission == nil {
                default(((BoundScope) -> void)?)
            } else {
                (root BoundScope) -> SubmissionBinding.ConfigureRootScope(root, submission)
            }
        )

        private func ReplayPriorCellImports($scope BoundScope) {
            let submission = $scope.SubmissionOptions
            if submission?.ReplayImports.IsDefaultOrEmpty == false {
                for replayed in submission!!.ReplayImports {
                    $scope.TryImport(ImportSymbol(replayed.Name, replayed.Target, declaration: nil))
                }
            }
        }

        private func GetDefaultPackageName($scope BoundScope) string -> $scope
            .SubmissionOptions
            ?.DefaultPackageName ??
            "Default"

        private func CaptureTrailingCellValue($scope BoundScope, statements ImmutableArray[BoundStatement].Builder) {
            let submission = $scope.SubmissionOptions
            if submission?.CaptureTrailingExpression != true || statements.Count == 0 {
                return
            }
            var resultVariable GlobalVariableSymbol? = nil
            let trailing = statements[statements.Count - 1]
            if trailing is BoundExpressionStatement trailingExpression &&
                IsCapturableEchoType(trailingExpression.Expression.Type) {
                resultVariable = GlobalVariableSymbol(
                    SubmissionImports.ResultFieldName,
                    isReadOnly: false,
                    trailingExpression.Expression.Type,
                    Accessibility.Public
                )
                statements[statements.Count - 1] = BoundVariableDeclaration(
                    trailing.Syntax,
                    resultVariable,
                    trailingExpression.Expression
                )
            } else if trailing is BoundVariableDeclaration trailingDeclaration &&
                !(trailingDeclaration.Initializer is BoundAddressOfExpression) &&
                IsCapturableEchoType(trailingDeclaration.Variable.Type) {
                resultVariable = GlobalVariableSymbol(
                    SubmissionImports.ResultFieldName,
                    isReadOnly: false,
                    trailingDeclaration.Variable.Type,
                    Accessibility.Public
                )
                statements.Add(
                    BoundVariableDeclaration(
                        trailing.Syntax,
                        resultVariable,
                        BoundVariableExpression(trailing.Syntax, trailingDeclaration.Variable)
                    )
                )
            } else if TryInferTrailingCaptureType(trailing, out var trailingBranchType) {
                resultVariable = GlobalVariableSymbol(
                    SubmissionImports.ResultFieldName,
                    isReadOnly: false,
                    trailingBranchType,
                    Accessibility.Public
                )
                statements[statements.Count - 1] = RewriteTrailingCapture(trailing, resultVariable)
            }
            if resultVariable != nil {
                $scope.TryDeclareVariable(resultVariable)
            }
        }

        private func FilterEntryPointForCell(
            $scope BoundScope,
            entryPoint FunctionSymbol?,
            synthesizedEntryPoint FunctionSymbol?
        ) FunctionSymbol? {
            let submission = $scope.SubmissionOptions
            if submission != nil && submission.RunUserEntryPoint == false {
                return synthesizedEntryPoint
            }
            return entryPoint
        }

        private func AttachPriorCellImports($scope BoundScope, result BoundGlobalScope) {
            result.SubmissionImports = $scope.SubmissionImports
        }

        private func CopyPriorCellImports(globalScope BoundGlobalScope, parent BoundScope) {
            SubmissionBinding.SetImports(parent, globalScope.SubmissionImports)
        }

        private func IsCapturableEchoType(type TypeSymbol?) bool -> type != nil &&
            type != TypeSymbol.Void &&
            type != TypeSymbol.Error &&
            !TypeSymbol.IsByRefLike(type)

        private func TryInferTrailingCaptureType(
            statement BoundStatement,
            @NotNullWhen(true) out type TypeSymbol?
        ) bool {
            switch statement {
                case expressionStatement is BoundExpressionStatement {
                    type = expressionStatement.Expression.Type
                    return IsCapturableEchoType(type)
                }
                case declaration is BoundVariableDeclaration when !(
                    declaration.Initializer is BoundAddressOfExpression
                ) {
                    type = declaration.Variable.Type
                    return IsCapturableEchoType(type)
                }
                case block is BoundBlockStatement when block.Statements.Length > 0 {
                    return TryInferTrailingCaptureType(block.Statements[block.Statements.Length - 1], out type)
                }
                case ifStatement is BoundIfStatement when ifStatement.ElseStatement != nil {
                    if TryInferTrailingCaptureType(ifStatement.ThenStatement, out var thenType) &&
                        TryInferTrailingCaptureType(ifStatement.ElseStatement!!, out var elseType) &&
                        thenType == elseType {
                        type = thenType
                        return true
                    }
                    type = nil
                    return false
                }
                case switchStatement is BoundPatternSwitchStatement when switchStatement
                    .Arms
                    .Length > 0 &&
                    (
                    switchStatement.IsExhaustive || switchStatement.Arms.Any(
                        (a BoundPatternSwitchArm) -> a.IsDefault && a.Guard == nil
                    )
                ) {
                    var common TypeSymbol? = nil
                    for arm in switchStatement.Arms {
                        if !TryInferTrailingCaptureType(arm.Body, out var armType) ||
                            (common != nil && armType != common) {
                            type = nil
                            return false
                        }
                        common = armType
                    }
                    type = common
                    return type != nil
                }
                default {
                    type = nil
                    return false
                }
            }
        }

        private func RewriteTrailingCapture(
            statement BoundStatement,
            resultVariable GlobalVariableSymbol
        ) BoundStatement {
            switch statement {
                case expressionStatement is BoundExpressionStatement {
                    return BoundExpressionStatement(
                        statement.Syntax,
                        BoundAssignmentExpression(statement.Syntax, resultVariable, expressionStatement.Expression)
                    )
                }
                case declaration is BoundVariableDeclaration {
                    return BoundBlockStatement(
                        statement.Syntax,
                        ImmutableArray.Create[BoundStatement](
                            declaration,
                            BoundExpressionStatement(
                                statement.Syntax,
                                BoundAssignmentExpression(
                                    statement.Syntax,
                                    resultVariable,
                                    BoundVariableExpression(statement.Syntax, declaration.Variable)
                                )
                            )
                        )
                    )
                }
                case block is BoundBlockStatement {
                    return BoundBlockStatement(
                        block.Syntax,
                        block.Statements.SetItem(
                            block.Statements.Length - 1,
                            RewriteTrailingCapture(block.Statements[block.Statements.Length - 1], resultVariable)
                        )
                    )
                }
                case ifStatement is BoundIfStatement {
                    let ifElseStatement = Invariant.Required(
                        ifStatement.ElseStatement,
                        "TryInferTrailingCaptureType verified this if-statement has an else branch",
                        expression: "ifStatement.ElseStatement"
                    )
                    return BoundIfStatement(
                        ifStatement.Syntax,
                        ifStatement.Condition,
                        RewriteTrailingCapture(ifStatement.ThenStatement, resultVariable),
                        RewriteTrailingCapture(ifElseStatement, resultVariable)
                    )
                }
                case switchStatement is BoundPatternSwitchStatement {
                    return BoundPatternSwitchStatement(
                        switchStatement.Syntax,
                        switchStatement.Discriminant,
                        switchStatement
                            .Arms
                            .Select(
                            (a BoundPatternSwitchArm) -> BoundPatternSwitchArm(
                                a.Syntax,
                                a.Pattern,
                                a.Guard,
                                RewriteTrailingCapture(a.Body, resultVariable)
                            )
                        )
                            .ToImmutableArray(),
                        switchStatement.IsExhaustive
                    )
                }
                default {
                    throw InvalidOperationException("Unexpected trailing-capture statement kind '${statement.Kind}'.")
                }
            }
        }
    }
}
