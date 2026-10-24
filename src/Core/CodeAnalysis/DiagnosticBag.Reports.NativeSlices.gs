// <copyright file="DiagnosticBag.Reports.NativeSlices.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic

partial class DiagnosticBag : IEnumerable[Diagnostic] {
    internal func ReportNativeSpanType(location TextLocation, reason string) -> Report(
        location,
        DiagnosticDescriptors.NativeSpanType,
        reason
    )

    internal func ReportNativeSliceRuntime(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.NativeSliceRuntime
    )

    internal func ReportNativeSliceType(location TextLocation, reason string) -> Report(
        location,
        DiagnosticDescriptors.NativeSliceType,
        reason
    )

    internal func ReportNativeSliceSuspendingWrite(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.NativeSliceSuspendingWrite
    )

    internal func ReportNativeSliceReadOnlyElement(location TextLocation) -> Report(
        location,
        DiagnosticDescriptors.NativeSliceReadOnlyElement
    )
}
