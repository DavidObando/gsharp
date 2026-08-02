using System.Text.RegularExpressions;

namespace Issue3086;

public sealed partial record GitHubUrl(string Owner, string Name, int? PrNumber)
{
    private const string PatternText =
        @"^https://(www\.)?github\.com/(?<owner>[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/(?<name>[A-Za-z0-9._-]+?)(\.git)?(/(pull/(?<pr>\d+))?)?/?$";

    public static bool TryParse(string? url, out GitHubUrl parsed)
    {
        parsed = new GitHubUrl(string.Empty, string.Empty, null);
        if (string.IsNullOrWhiteSpace(url))
        {
            return false;
        }

        var match = Pattern().Match(url.Trim());
        if (!match.Success)
        {
            return false;
        }

        int? prNumber = match.Groups["pr"].Success ? int.Parse(match.Groups["pr"].Value) : null;
        parsed = new GitHubUrl(match.Groups["owner"].Value, match.Groups["name"].Value, prNumber);
        return true;
    }

    public static bool HasExpectedRegexSemantics()
    {
        Regex regex = Pattern();
        return regex.ToString() == PatternText &&
            regex.Options == RegexOptions.ExplicitCapture &&
            regex.MatchTimeout.TotalMilliseconds == 1000 &&
            object.ReferenceEquals(regex, Pattern());
    }

    public static bool HasDefaultRegexSemantics()
    {
        Regex defaultRegex = DefaultPattern();
        Regex infiniteRegex = InfinitePattern();
        return defaultRegex.ToString() == "^default$" &&
            defaultRegex.Options == RegexOptions.None &&
            defaultRegex.MatchTimeout.TotalMilliseconds == 250 &&
            object.ReferenceEquals(defaultRegex, DefaultPattern()) &&
            infiniteRegex.MatchTimeout == Regex.InfiniteMatchTimeout &&
            object.ReferenceEquals(infiniteRegex, InfinitePattern());
    }

    public static bool HasInvariantInlineIgnoreCaseSemantics()
    {
        Regex regex = InvariantPattern();
        return regex.IsMatch("INVARIANT") &&
            regex.Options == RegexOptions.CultureInvariant &&
            object.ReferenceEquals(regex, InvariantPattern());
    }

    [GeneratedRegex(
        PatternText,
        RegexOptions.ExplicitCapture,
        matchTimeoutMilliseconds: 1000)]
    private static partial Regex Pattern();

    [GeneratedRegex("^default$")]
    private static partial Regex DefaultPattern();

    [GeneratedRegex("^infinite$", RegexOptions.None, matchTimeoutMilliseconds: -1)]
    private static partial Regex InfinitePattern();

    [GeneratedRegex("(?i)^invariant$", RegexOptions.CultureInvariant)]
    private static partial Regex InvariantPattern();
}

public sealed partial class InstanceRegexOwner
{
    [GeneratedRegex("^[a-z]+$")]
    public partial Regex LowercaseWords();
}

public static class Program
{
    public static void Main()
    {
        AppContext.SetData("REGEX_DEFAULT_MATCH_TIMEOUT", TimeSpan.FromMilliseconds(250));

        AssertUrl("https://github.com/DavidObando/gsharp", null);
        AssertUrl("https://github.com/DavidObando/gsharp/pull/3086", 3086);

        if (!GitHubUrl.HasExpectedRegexSemantics())
        {
            throw new InvalidOperationException("GeneratedRegex semantics changed.");
        }

        if (!GitHubUrl.HasDefaultRegexSemantics() ||
            !GitHubUrl.HasInvariantInlineIgnoreCaseSemantics())
        {
            throw new InvalidOperationException("GeneratedRegex default semantics changed.");
        }

        var firstOwner = new InstanceRegexOwner();
        var secondOwner = new InstanceRegexOwner();
        Regex firstRegex = firstOwner.LowercaseWords();
        if (!firstRegex.IsMatch("lowercase") ||
            firstRegex.IsMatch("UPPERCASE") ||
            !object.ReferenceEquals(firstRegex, firstOwner.LowercaseWords()) ||
            !object.ReferenceEquals(firstRegex, secondOwner.LowercaseWords()))
        {
            throw new InvalidOperationException("GeneratedRegex instance lowering changed.");
        }

        Console.WriteLine("repository+pull-request+regex-ok");
    }

    private static void AssertUrl(string url, int? expectedPullRequest)
    {
        if (!GitHubUrl.TryParse(url, out GitHubUrl parsed) ||
            parsed.Owner != "DavidObando" ||
            parsed.Name != "gsharp" ||
            parsed.PrNumber != expectedPullRequest)
        {
            throw new InvalidOperationException("GitHub URL parse failed: " + url);
        }
    }
}
