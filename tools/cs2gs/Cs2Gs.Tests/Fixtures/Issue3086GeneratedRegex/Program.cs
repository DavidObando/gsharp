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

    [GeneratedRegex(
        PatternText,
        RegexOptions.ExplicitCapture,
        matchTimeoutMilliseconds: 1000)]
    private static partial Regex Pattern();
}

public static class Program
{
    public static void Main()
    {
        AssertUrl("https://github.com/DavidObando/gsharp", null);
        AssertUrl("https://github.com/DavidObando/gsharp/pull/3086", 3086);

        if (!GitHubUrl.HasExpectedRegexSemantics())
        {
            throw new InvalidOperationException("GeneratedRegex semantics changed.");
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
