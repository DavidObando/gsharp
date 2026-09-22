// <copyright file="DiagnosticBag.Reports.ManagedReferences.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis;

public sealed partial class DiagnosticBag
{
    internal void ReportManagedReference(TextLocation location, string reason)
        => Report(location, DiagnosticDescriptors.ManagedReference, reason);
}
