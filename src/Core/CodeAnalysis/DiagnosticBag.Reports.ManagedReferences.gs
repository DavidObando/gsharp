// <copyright file="DiagnosticBag.Reports.ManagedReferences.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic

partial class DiagnosticBag : IEnumerable[Diagnostic] {
    internal func ReportManagedReference(location TextLocation, reason string) -> Report(
        location,
        DiagnosticDescriptors.ManagedReference,
        reason
    )
}
