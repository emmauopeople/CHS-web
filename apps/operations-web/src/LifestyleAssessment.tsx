import { displayValue, formatDate, formatInstant, humanize } from './format';
import type { LifestyleAssessmentView } from './types';

function ValueList({ values }: Readonly<{ values: readonly string[] }>) {
  return values.length > 0
    ? values.map(humanize).join(', ')
    : '—';
}

function WeeklyHeading({
  title,
  response,
}: Readonly<{ title: string; response: string }>) {
  return (
    <header className="lifestyle-domain-heading">
      <h5>{title}</h5>
      <span className="lifestyle-response">{humanize(response)}</span>
    </header>
  );
}

function TechnicalReference({
  label,
  id,
  version,
}: Readonly<{ label: string; id: string; version: number }>) {
  return (
    <div className="baseline-reference">
      <div>
        <strong>{label}</strong>
        <span>Version {version}</span>
      </div>
      <code>{id}</code>
    </div>
  );
}

export function LifestyleAssessment({
  assessment,
}: Readonly<{ assessment: LifestyleAssessmentView | null }>) {
  if (!assessment) {
    return (
      <div className="empty-inline lifestyle-empty">
        No finalized canonical Lifestyle assessment is available for this encounter.
      </div>
    );
  }

  const { alcohol, tobacco, physicalActivity, work, otherActivity, baselines } =
    assessment;

  return (
    <section
      className="lifestyle-assessment"
      aria-labelledby={`lifestyle-${assessment.lifestyleAssessmentId}`}
    >
      <header className="lifestyle-heading">
        <div>
          <p className="eyebrow">Finalized canonical assessment</p>
          <h4 id={`lifestyle-${assessment.lifestyleAssessmentId}`}>Lifestyle</h4>
          <p>
            {formatDate(assessment.periodStart)}–{formatDate(assessment.periodEnd)}
          </p>
        </div>
        <span className="status lifestyle-complete">Complete</span>
      </header>

      <dl className="lifestyle-provenance">
        <div>
          <dt>Completed</dt>
          <dd>{formatInstant(assessment.completedAt)}</dd>
        </div>
        <div>
          <dt>Recorded by</dt>
          <dd>{assessment.recordedByPractitionerName}</dd>
        </div>
      </dl>

      <div className="lifestyle-domain-grid">
        <article className="lifestyle-domain">
          <WeeklyHeading title="Alcohol" response={alcohol.weeklyResponse} />
          <dl className="lifestyle-facts">
            <div><dt>Drinking days</dt><dd>{displayValue(alcohol.drinkingDays)}</dd></div>
            <div><dt>Total standard drinks</dt><dd>{displayValue(alcohol.totalStandardizedDrinks)}</dd></div>
            <div><dt>Largest amount in one day</dt><dd>{displayValue(alcohol.largestOneDayAmount)}</dd></div>
            <div><dt>Days at largest amount</dt><dd>{displayValue(alcohol.daysAtLargestAmount)}</dd></div>
            <div className="lifestyle-fact-wide">
              <dt>Common beverages</dt>
              <dd><ValueList values={alcohol.commonBeverageTypes} /></dd>
            </div>
            {alcohol.otherBeverageDescription ? (
              <div className="lifestyle-fact-wide">
                <dt>Other beverage</dt>
                <dd>{alcohol.otherBeverageDescription}</dd>
              </div>
            ) : null}
          </dl>
        </article>

        <article className="lifestyle-domain">
          <WeeklyHeading title="Tobacco" response={tobacco.weeklyResponse} />
          {tobacco.products.length > 0 ? (
            <ol className="lifestyle-entry-list">
              {tobacco.products.map((product) => (
                <li key={product.productId}>
                  <strong>{humanize(product.productType)}</strong>
                  <span>
                    {product.daysUsed} day{product.daysUsed === 1 ? '' : 's'} ·{' '}
                    {product.averageQuantityPerUseDay} {humanize(product.unit).toLowerCase()} per use day
                  </span>
                  {product.secondhandSmokeExposure !== null ? (
                    <span>Secondhand smoke exposure: {product.secondhandSmokeExposure ? 'Yes' : 'No'}</span>
                  ) : null}
                  {product.otherProductDescription ? <span>{product.otherProductDescription}</span> : null}
                  {product.otherUnitDescription ? <span>Unit: {product.otherUnitDescription}</span> : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="lifestyle-domain-empty">No tobacco product rows recorded.</p>
          )}
        </article>

        <article className="lifestyle-domain">
          <WeeklyHeading title="Physical activity" response={physicalActivity.weeklyResponse} />
          <dl className="lifestyle-facts lifestyle-facts-compact">
            <div>
              <dt>Sedentary time</dt>
              <dd>{humanize(physicalActivity.sedentaryTimeResponse)}</dd>
            </div>
            <div>
              <dt>Minutes per day</dt>
              <dd>{displayValue(physicalActivity.sedentaryMinutesPerDay)}</dd>
            </div>
          </dl>
          {physicalActivity.activities.length > 0 ? (
            <ol className="lifestyle-entry-list">
              {physicalActivity.activities.map((activity) => (
                <li key={activity.activityId}>
                  <strong>{humanize(activity.activityDomain)}</strong>
                  <span>
                    {humanize(activity.intensity)} · {activity.daysInPastSevenDays} day
                    {activity.daysInPastSevenDays === 1 ? '' : 's'} ·{' '}
                    {activity.averageMinutesPerActiveDay} min/day
                  </span>
                  {activity.description ? <span>{activity.description}</span> : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="lifestyle-domain-empty">No activity rows recorded.</p>
          )}
        </article>

        <article className="lifestyle-domain">
          <WeeklyHeading title="Work" response={work.weeklyResponse} />
          <dl className="lifestyle-facts">
            <div className="lifestyle-fact-wide">
              <dt>Occupation</dt>
              <dd>{displayValue(baselines.work.occupationJobTitle)}</dd>
            </div>
            <div><dt>Baseline status</dt><dd>{humanize(baselines.work.status)}</dd></div>
            <div><dt>Physical demand</dt><dd>{humanize(baselines.work.usualPhysicalDemand)}</dd></div>
            <div><dt>Workdays/week</dt><dd>{displayValue(baselines.work.typicalWorkdaysPerWeek)}</dd></div>
            <div><dt>Hours/workday</dt><dd>{displayValue(baselines.work.typicalHoursPerWorkday)}</dd></div>
            <div><dt>Shift</dt><dd>{humanize(baselines.work.shiftPattern)}</dd></div>
            {baselines.work.description ? (
              <div className="lifestyle-fact-wide">
                <dt>Description</dt>
                <dd>{baselines.work.description}</dd>
              </div>
            ) : null}
          </dl>
        </article>

        <article className="lifestyle-domain lifestyle-domain-wide">
          <WeeklyHeading title="Other activity" response={otherActivity.weeklyResponse} />
          {otherActivity.activities.length > 0 ? (
            <ol className="lifestyle-entry-list lifestyle-entry-grid">
              {otherActivity.activities.map((activity) => (
                <li key={activity.activityId}>
                  <strong>{humanize(activity.category)}</strong>
                  <span>
                    {humanize(activity.intensity)} · {activity.daysInPastSevenDays} day
                    {activity.daysInPastSevenDays === 1 ? '' : 's'} ·{' '}
                    {activity.averageMinutesPerDay} min/day
                  </span>
                  {activity.description ? <span>{activity.description}</span> : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="lifestyle-domain-empty">No other activity rows recorded.</p>
          )}
        </article>
      </div>

      <details className="lifestyle-baselines">
        <summary>Baseline versions used for this assessment</summary>
        <p>
          These are the exact immutable versions used to interpret this completed week.
        </p>
        <div className="baseline-reference-list">
          <TechnicalReference
            label={`Alcohol · ${humanize(baselines.alcohol.status)}`}
            id={baselines.alcohol.baselineId}
            version={baselines.alcohol.version}
          />
          <TechnicalReference
            label={`Tobacco · ${humanize(baselines.tobacco.status)}`}
            id={baselines.tobacco.baselineId}
            version={baselines.tobacco.version}
          />
          <TechnicalReference
            label={`Work · ${humanize(baselines.work.status)}`}
            id={baselines.work.baselineId}
            version={baselines.work.version}
          />
        </div>
        <dl className="baseline-summary">
          <div>
            <dt>Alcohol baseline</dt>
            <dd>
              Ever consumed: {humanize(baselines.alcohol.everConsumed)} · Past 12 months:{' '}
              {humanize(baselines.alcohol.consumedPast12Months)} · Beverages:{' '}
              <ValueList values={baselines.alcohol.commonBeverageTypes} />
              {baselines.alcohol.otherBeverageDescription
                ? ` · Other: ${baselines.alcohol.otherBeverageDescription}`
                : ''}
            </dd>
          </div>
          <div>
            <dt>Tobacco baseline</dt>
            <dd>
              Ever regularly used: {humanize(baselines.tobacco.everRegularlyUsed)} · Frequency:{' '}
              {humanize(baselines.tobacco.currentUseFrequency)} · Products:{' '}
              <ValueList values={baselines.tobacco.productTypes} />
              {baselines.tobacco.formerUseApproximateStopDate
                ? ` · Approximate stop: ${baselines.tobacco.formerUseApproximateStopDate}`
                : ''}
              {baselines.tobacco.otherProductDescription
                ? ` · Other: ${baselines.tobacco.otherProductDescription}`
                : ''}
            </dd>
          </div>
        </dl>
        <div className="assessment-reference">
          Assessment reference: <code>{assessment.lifestyleAssessmentId}</code>
        </div>
      </details>
    </section>
  );
}
