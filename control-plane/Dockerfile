FROM python:3.13-slim
WORKDIR /app
COPY control-plane/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
COPY control-plane/lab ./lab
COPY scenarios ./scenarios
ENV SCENARIO_DIR=/app/scenarios PYTHONUNBUFFERED=1
RUN useradd --create-home lab
USER lab
EXPOSE 8000
CMD ["uvicorn", "lab.app:app", "--host", "0.0.0.0", "--port", "8000"]
